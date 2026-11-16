// kage setup, run for real from a temp copy with a fake Slack (curl), a fake service and a fake claude.
// Nothing here talks to Slack, launchd or systemd, or opens a browser.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const REPO = join(import.meta.dirname, '..')
const exe = (path: string, text: string) => { writeFileSync(path, text); chmodSync(path, 0o755) }

// A Kage folder with the real setup.sh and a fake service.sh. The fake service's `on` starts a
// stand-in hub (a sleep) and writes the status file as the real hub does once Slack connects,
// unless FAKE_NO_CONNECT is set.
function world() {
  const root = mkdtempSync(join(tmpdir(), 'kage-setup-'))
  const dir = join(root, 'code'), conf = join(root, 'conf'), bin = join(root, 'bin'), home = join(root, 'home')
  for (const d of [dir, conf, bin, home, join(dir, 'cli'), join(dir, 'core')]) mkdirSync(d, { recursive: true })
  copyFileSync(join(REPO, 'setup.sh'), join(dir, 'setup.sh'))
  for (const f of ['manifest.ts', 'config.ts', 'home.ts']) copyFileSync(join(REPO, 'cli', f), join(dir, 'cli', f))
  mkdirSync(join(dir, 'runtime'))
  for (const f of ['config-files.ts', 'hub-client.ts']) copyFileSync(join(REPO, 'runtime', f), join(dir, 'runtime', f))
  symlinkSync(join(REPO, 'node_modules'), join(dir, 'node_modules'))
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

describe('kage save writes the tokens to secrets.json, private, and keeps the other settings', () => {
  test('tokens replace the old ones; the name is set; other settings stay; both files are 600', async () => {
    const w = world()
    writeFileSync(w.env, 'KAGE_NAME=old\nSLACK_BOT_TOKEN=xoxb-OLD\nKAGE_TEAMMATES=UTEST2\n', { mode: 0o644 })
    const r = await w.run(['save', 'kagetest'], 'xapp-TEST xoxp-TEST xoxb-TEST\n')
    assert.equal(r.code, 0, r.out)
    const secrets = JSON.parse(readFileSync(join(w.conf, 'secrets.json'), 'utf8'))
    assert.deepEqual(secrets.slack, { app: 'xapp-TEST', user: 'xoxp-TEST', bot: 'xoxb-TEST' })
    const config = JSON.parse(readFileSync(join(w.conf, 'config.json'), 'utf8'))
    assert.equal(config.name, 'kagetest')
    assert.deepEqual(config.people.teammates, ['UTEST2'])
    for (const f of ['config.json', 'secrets.json']) assert.equal(statSync(join(w.conf, f)).mode & 0o777, 0o600, f)
    assert.ok(!r.out.includes('xoxp-TEST'), 'no token in the output')
    assert.deepEqual(readdirSync(w.conf).filter(f => !f.startsWith('env.imported-') && !['config.json', 'secrets.json'].includes(f)), [], 'no temp file left behind')
  })
  test('on a new machine it creates both files from nothing', async () => {
    const w = world()
    const r = await w.run(['save', 'kagetest'], 'xapp-TEST xoxp-TEST xoxb-TEST\n')
    assert.equal(r.code, 0, r.out)
    assert.equal(JSON.parse(readFileSync(join(w.conf, 'config.json'), 'utf8')).name, 'kagetest')
  })
})

// A checkout with an origin one commit ahead, a fake service that logs stop and start, and a fake npm that logs whether the hub
// was up while it ran. npm ci deletes node_modules first, so a hub or a kage command running then crashes (seen on 0.4.0 to 0.4.1).
async function updateWorld(lockChanges: boolean, hubUp = true) {
  const w = world()
  const ops = join(w.root, 'ops')
  // A drain holds every new message until each running turn ends (#309), so update must never start one.
  writeFileSync(join(w.dir, 'cli', 'quiet.ts'), `import { appendFileSync } from 'node:fs'\nappendFileSync(${JSON.stringify(ops)}, 'drain\\n')\n`)
  exe(join(w.dir, 'service.sh'), `#!/usr/bin/env bash
case "$1" in
  installed) true ;;
  running) [[ -f "${w.root}/hub-up" ]] ;;
  stop) rm -f "${w.root}/hub-up"; echo stop >> "${ops}" ;;
  start) touch "${w.root}/hub-up"; echo start >> "${ops}" ;;
  restart) echo restart >> "${ops}" ;;
esac
`)
  exe(join(w.root, 'bin', 'npm'), `#!/bin/sh\necho "npm $1 hub=$([ -f "${w.root}/hub-up" ] && echo up || echo down)" >> "${ops}"\n`)
  // Logs each node run on the new commit: node beside the hub's own npm ci crashes on a half-deleted package (#302).
  exe(join(w.root, 'bin', 'node'), `#!/bin/sh\n[ "$(git -C "${w.dir}" log -1 --format=%s)" = two ] && echo "node after merge" >> "${ops}"\nexec "${process.execPath}" "$@"\n`)
  writeFileSync(join(w.dir, 'package-lock.json'), '{"version":"1"}\n')
  writeFileSync(join(w.dir, '.gitignore'), 'node_modules\n')
  const git = (cwd: string, ...a: string[]) => new Promise<void>((res, rej) => execFile('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.test', ...a], { cwd }, e => e ? rej(e) : res()))
  await git(w.dir, 'init', '-q', '-b', 'main'); await git(w.dir, 'add', '-A'); await git(w.dir, 'commit', '-qm', 'one')
  const origin = join(w.root, 'origin.git'), other = join(w.root, 'other')
  await git(w.root, 'clone', '-q', '--bare', w.dir, origin); await git(w.dir, 'remote', 'add', 'origin', origin); await git(w.dir, 'fetch', '-q', 'origin')
  await git(w.root, 'clone', '-q', origin, other)
  writeFileSync(join(other, lockChanges ? 'package-lock.json' : 'README.md'), '{"version":"2"}\n')
  await git(other, 'add', '-A'); await git(other, 'commit', '-qm', 'two'); await git(other, 'push', '-q', 'origin', 'main')
  if (hubUp) touch(join(w.root, 'hub-up'))
  const r = await w.run(['update'], '')
  return { r, ops: existsSync(ops) ? readFileSync(ops, 'utf8').trim().split('\n').filter(Boolean) : [] }
}
const touch = (f: string) => writeFileSync(f, '')

// The running hub restarts into new code at its next quiet moment and runs npm ci itself first (hub/updates.ts selfUpdate),
// so update only moves the checkout. Holding messages for a drain, or a kage command beside the hub's npm ci, are both gone.
describe('kage update moves the code and leaves the restart to the hub', () => {
  test('with the hub up and a changed lockfile, it holds no message and runs no npm', async () => {
    const { r, ops } = await updateWorld(true)
    assert.equal(r.code, 0, r.out)
    assert.deepEqual(ops, [], r.out)
    assert.match(r.out, /next quiet moment/)
  })
  test('with the hub up and the same lockfile, it holds no message and restarts nothing', async () => {
    const { r, ops } = await updateWorld(false)
    assert.equal(r.code, 0, r.out)
    assert.deepEqual(ops, [], r.out)
  })
  test('with the hub down, it installs the new packages itself', async () => {
    const { r, ops } = await updateWorld(true, false)
    assert.equal(r.code, 0, r.out)
    assert.deepEqual(ops, ['npm ci hub=down'], r.out)
  })
})
