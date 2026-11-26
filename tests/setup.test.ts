import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const REPO = join(import.meta.dirname, '..')
const exe = (path: string, text: string) => { writeFileSync(path, text); chmodSync(path, 0o755) }

function world() {
  const root = mkdtempSync(join(tmpdir(), 'kage-setup-'))
  const dir = join(root, 'code'), conf = join(root, 'conf'), bin = join(root, 'bin'), home = join(root, 'home')
  for (const d of [dir, conf, bin, home, join(dir, 'src', 'cli'), join(dir, 'src', 'core')]) mkdirSync(d, { recursive: true })
  copyFileSync(join(REPO, 'setup.sh'), join(dir, 'setup.sh'))
  for (const f of ['manifest.ts', 'tailscale.ts', 'config.ts', 'home.ts', 'update.ts', 'voice.ts', 'output.ts', 'setup-flow.ts']) copyFileSync(join(REPO, 'src', 'cli', f), join(dir, 'src', 'cli', f))
  mkdirSync(join(dir, 'src', 'runtime'), { recursive: true })
  for (const f of ['config-files.ts', 'hub-client.ts', 'owner-key.ts', 'self-update.ts']) copyFileSync(join(REPO, 'src', 'runtime', f), join(dir, 'src', 'runtime', f))
  symlinkSync(join(REPO, 'node_modules'), join(dir, 'node_modules'))
  for (const f of readdirSync(join(REPO, 'src', 'core')).filter(f => f.endsWith('.ts'))) cpSync(join(REPO, 'src', 'core', f), join(dir, 'src', 'core', f))
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
  test('bare kage on a machine with no settings runs the same setup', async () => {
    const w = world()
    const r = await w.run([], ANSWERS)
    assert.equal(r.code, 0, r.out)
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
    assert.deepEqual(config.people.teammates, [{ user: 'UTEST2' }])
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

async function updateWorld(lockChanges: boolean, hubUp = true) {
  const w = world()
  const ops = join(w.root, 'ops')
  writeFileSync(join(w.dir, 'src', 'cli', 'quiet.ts'), `import { appendFileSync } from 'node:fs'\nappendFileSync(${JSON.stringify(ops)}, 'drain\\n')\n`)
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
  exe(join(w.root, 'bin', 'node'), `#!/bin/sh\n[ "$(git -C "${w.dir}" log -1 --format=%s)" = two ] && echo "node after merge" >> "${ops}"\nexec "${process.execPath}" "$@"\n`)
  writeFileSync(join(w.dir, 'package-lock.json'), '{"version":"1"}\n')
  writeFileSync(join(w.dir, '.gitignore'), 'node_modules\n')
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
const git = (cwd: string, ...a: string[]) => new Promise<void>((res, rej) => execFile('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.test', ...a], { cwd }, e => e ? rej(e) : res()))
const touch = (f: string) => writeFileSync(f, '')

describe('kage update moves the code and leaves the restart to the hub', () => {
  test('with the hub up and a changed lockfile, it holds no message and runs no npm', async () => {
    const { r, ops } = await updateWorld(true)
    assert.equal(r.code, 0, r.out)
    assert.deepEqual(ops, [], r.out)
    assert.match(r.out, /I'll switch over when I'm not in the middle of anything, after I install what it needs\./)
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

describe('kage update says what is new in plain words', () => {
  test('feat and fix commits become two short lists; type, scope and PR number go', async () => {
    const w = world()
    const origin = join(w.root, 'origin.git'), other = join(w.root, 'other')
    await git(w.dir, 'init', '-q', '-b', 'main')
    await git(w.dir, 'add', '-A')
    await git(w.dir, 'commit', '-qm', 'base')
    await git(w.root, 'clone', '-q', '--bare', w.dir, origin)
    await git(w.dir, 'remote', 'add', 'origin', origin)
    await git(w.dir, 'fetch', '-q', 'origin')
    await git(w.root, 'clone', '-q', origin, other)
    for (const m of ['feat(cli): token prompts show a dot per character (#408)', 'feat(cli/slack): kage slack upgrade edits the manifest itself', 'fix(core/slack-scopes): an empty list pastes cleanly', 'refactor(core): one table', 'docs: words'])
      await git(other, 'commit', '-q', '--allow-empty', '-m', m)
    await git(other, 'push', '-q', 'origin', 'main')
    const r = await w.run(['update'], '')
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /✦ Got the new version\./)
    assert.match(r.out, /What's new for you\n(  · .*\n)*  · kage slack upgrade edits the manifest itself\n/)
    assert.match(r.out, /  · Token prompts show a dot per character\n/)
    assert.doesNotMatch(r.out, /Kage slack upgrade/)
    assert.match(r.out, /Fixed\n  · An empty list pastes cleanly\n/)
    assert.doesNotMatch(r.out, /refactor|one table|words|#408|\x1b\[/)
    assert.match(r.out, /I'm not running\. Start me: kage start/)
  })
})

describe('kage update inside a Kage session goes through the hub and prints the same lines', () => {
  const hub = (w: ReturnType<typeof world>, answer: object) => {
    const asked: object[] = []
    const server = createServer(sock => sock.on('data', b => { asked.push(JSON.parse(String(b))); sock.write(JSON.stringify({ type: 'update', ...answer }) + '\n') }))
    server.listen(join(w.conf, 'router.sock'))
    return { asked, server }
  }
  const ready = (s: ReturnType<typeof hub>['server']) => new Promise(res => s.on('listening', res))
  test('a moved checkout says what is new and that the hub switches later, and sends no ref', async () => {
    const w = world()
    const h = hub(w, { moved: { old: 'aaa', new: 'bbb', packages: true, subjects: ['feat(cli): a new thing (#1)', 'fix(core): a fixed thing', 'docs: words'] } })
    await ready(h.server)
    const r = await w.run(['update'], '', { KAGE_CLAUDE: '1' })
    h.server.close()
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /Got the new version\./)
    assert.match(r.out, /I'll switch over when I'm not in the middle of anything, after I install what it needs\./)
    assert.match(r.out, /What's new for you\n  · A new thing\n/)
    assert.match(r.out, /Fixed\n  · A fixed thing\n/)
    assert.deepEqual(h.asked.map(a => Object.keys(a).sort()), [['ownerKey', 'stable', 'type']])
  })
  test('already current says so, and a refusal from the hub exits 1 with its words', async () => {
    const w = world()
    let h = hub(w, { current: true })
    await ready(h.server)
    const r = await w.run(['update', '--stable'], '', { KAGE_CLAUDE: '1' })
    h.server.close()
    assert.match(r.out, /already on the newest version/)
    assert.equal((h.asked[0] as { stable: boolean }).stable, true)
    w.run(['help'], '')
    h = hub(w, { refused: 'this checkout has local changes, so it was left as it is: a.ts' })
    await ready(h.server)
    const bad = await w.run(['update'], '', { KAGE_CLAUDE: '1' })
    h.server.close()
    assert.equal(bad.code, 1)
    assert.match(bad.out, /This checkout has local changes/)
  })
})
