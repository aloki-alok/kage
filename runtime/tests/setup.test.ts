// kage setup, run for real from a temp copy with a fake Slack (curl), a fake service and a fake claude.
// Nothing here talks to Slack, launchd or systemd, or opens a browser.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const REPO = join(import.meta.dirname, '../..')
const exe = (path: string, text: string) => { writeFileSync(path, text); chmodSync(path, 0o755) }

// A Kage folder with the real setup.sh and a fake service.sh. The fake service's `on` starts a
// stand-in hub (a sleep) and writes the status file as the real hub does once Slack connects,
// unless FAKE_NO_CONNECT is set.
function world() {
  const root = mkdtempSync(join(tmpdir(), 'kage-setup-'))
  const dir = join(root, 'code'), conf = join(root, 'conf'), bin = join(root, 'bin'), home = join(root, 'home')
  for (const d of [dir, conf, bin, home, join(dir, 'cli'), join(dir, 'core')]) mkdirSync(d, { recursive: true })
  copyFileSync(join(REPO, 'setup.sh'), join(dir, 'setup.sh'))
  copyFileSync(join(REPO, 'cli/manifest.ts'), join(dir, 'cli/manifest.ts'))
  for (const f of readdirSync(join(REPO, 'core')).filter(f => f.endsWith('.ts'))) cpSync(join(REPO, 'core', f), join(dir, 'core', f))
  const env = join(conf, 'env')
  exe(join(dir, 'service.sh'), `#!/usr/bin/env bash
case "$1" in
  installed) [[ -f "${root}/service-on" ]] ;;
  on|start) touch "${root}/service-on"; sleep 30 >/dev/null 2>&1 & pid=$!
    [[ -n "\${FAKE_NO_CONNECT:-}" ]] || echo "connected 2026-11-14T00:00:00Z pid $pid as @kagetest" > "${conf}/status" ;;
  running) [[ -f "${root}/service-on" ]] ;;
  kind) echo none ;;
esac
`)
  // Slack answers every token check with ok and the owner's id.
  exe(join(bin, 'curl'), '#!/bin/sh\ncat >/dev/null\necho \'{"ok":true,"user_id":"UTEST1"}\'\n')
  exe(join(bin, 'claude'), '#!/bin/sh\necho 1.0.0\n')
  for (const b of ['open', 'xdg-open']) exe(join(bin, b), '#!/bin/sh\nexit 0\n')
  const run = (args: string[], stdin: string, extra: Record<string, string> = {}) => new Promise<{ code: number; out: string }>(res => {
    const p = execFile('/bin/bash', [join(dir, 'setup.sh'), ...args], {
      env: { PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: home, KAGE_ENV: env, KAGE_SETUP_WAIT: '4', ...extra },
    }, (e, stdout, stderr) => res({ code: e ? Number(e.code ?? 1) : 0, out: stdout + stderr }))
    p.stdin!.end(stdin)
  })
  return { root, dir, conf, env, run }
}

const ANSWERS = 'kagetest\n\nxapp-TEST xoxp-TEST xoxb-TEST\n'

describe('kage setup ends with Kage running and connected, not with a list of steps left to do', () => {
  test('after the tokens it starts the service, waits for Slack, and says to tag the name', async () => {
    const w = world()
    const r = await w.run(['setup'], ANSWERS)
    assert.equal(r.code, 0, r.out)
    assert.ok(existsSync(join(w.root, 'service-on')), 'the service was turned on')
    assert.match(r.out, /Connected to Slack\. Tag @kagetest in any thread to try it\./)
  })
  test('if Slack does not connect in time, it exits non-zero and points at kage doctor', async () => {
    const w = world()
    const r = await w.run(['setup'], ANSWERS, { FAKE_NO_CONNECT: '1' })
    assert.notEqual(r.code, 0)
    assert.match(r.out, /kage doctor/)
  })
})

describe('kage save writes the env file whole, private, and keeps the other settings', () => {
  test('tokens replace the old ones; other lines stay; the file is 600', async () => {
    const w = world()
    writeFileSync(w.env, 'KAGE_NAME=old\nSLACK_BOT_TOKEN=xoxb-OLD\nKAGE_TEAMMATES=UTEST2\n', { mode: 0o644 })
    const r = await w.run(['save', 'kagetest'], 'xapp-TEST xoxp-TEST xoxb-TEST\n')
    assert.equal(r.code, 0, r.out)
    const text = readFileSync(w.env, 'utf8')
    assert.equal(text, 'KAGE_NAME=kagetest\nSLACK_APP_TOKEN=xapp-TEST\nSLACK_USER_TOKEN=xoxp-TEST\nSLACK_BOT_TOKEN=xoxb-TEST\nKAGE_TEAMMATES=UTEST2\n')
    assert.equal(statSync(w.env).mode & 0o777, 0o600)
    assert.deepEqual(readdirSync(w.conf).filter(f => f !== 'env'), [], 'no temp file left behind')
  })
})
