// What keeps the hub alive (hub.ts, service.sh, the hub lock), run for real from a temp copy with a fake
// hub (router.ts) and a fake Slack API. Nothing here talks to Slack, launchd or systemd.
import { describe, test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { chmodSync, closeSync, openSync, copyFileSync, mkdirSync, realpathSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const REPO = join(import.meta.dirname, '../..')
const FAKE_HUB = `console.log('fake hub up in ' + process.cwd()); console.error('boom ' + process.env.FAKE_EXIT); process.exit(Number(process.env.FAKE_EXIT ?? 0))`

type Run = { code: number | null; out: string }
const sh = (args: string[], env: Record<string, string>): Promise<Run> => new Promise(res =>
  execFile('/bin/bash', args, { env: { PATH: `${dirname(process.execPath)}:${process.env.PATH}`, HOME: env.HOME ?? tmpdir(), ...env } }, (e, stdout, stderr) =>
    res({ code: e ? (typeof e.code === 'number' ? e.code : null) : 0, out: stdout + stderr })))

// A Kage folder with the real scripts and a fake hub, and a config folder with an env file.
function kageCopy() {
  const root = mkdtempSync(join(tmpdir(), 'kage-svc-'))
  const dir = join(root, 'code'), conf = join(root, 'conf'), work = join(root, 'work')
  for (const d of [dir, conf, work, join(dir, 'node_modules')]) mkdirSync(d, { recursive: true })
  for (const f of ['hub.ts', 'service.sh']) copyFileSync(join(REPO, f), join(dir, f))
  mkdirSync(join(dir, 'runtime'))
  copyFileSync(join(REPO, 'runtime/hub-log.ts'), join(dir, 'runtime/hub-log.ts'))
  writeFileSync(join(dir, 'router.ts'), FAKE_HUB)
  // The packages are current: the lock is older than npm's stamp.
  writeFileSync(join(dir, 'package-lock.json'), '{}')
  utimesSync(join(dir, 'package-lock.json'), new Date(0), new Date(0))
  writeFileSync(join(dir, 'node_modules', '.package-lock.json'), '{}')
  const envFile = join(conf, 'env')
  writeFileSync(envFile, 'KAGE_NAME=kagetest\nSLACK_APP_TOKEN=xapp-test\nSLACK_USER_TOKEN=xoxp-test\nSLACK_BOT_TOKEN=xoxb-test\n', { mode: 0o600 })
  return { root, dir, conf, work, envFile }
}

describe('hub.ts: one hub run, with its log, its boot count and a crash-loop DM', () => {
  let api: Server, url = ''
  const calls: { path: string; auth: string; body: string }[] = []
  before(async () => {
    api = createServer((req, res) => {
      let body = ''
      req.on('data', c => body += c).on('end', () => {
        calls.push({ path: req.url!, auth: req.headers.authorization ?? '', body })
        res.end(req.url === '/auth.test' ? '{"ok":true,"user_id":"UOWNER1"}' : '{"ok":true}')
      })
    })
    await new Promise<void>(r => api.listen(0, '127.0.0.1', r))
    url = `http://127.0.0.1:${(api.address() as { port: number }).port}`
  })
  after(() => api.close())
  // As launchd and systemd run it: node on hub.ts, its output appended to hub.log.
  const hub = (k: ReturnType<typeof kageCopy>, env: Record<string, string> = {}) => new Promise<number | null>(res => {
    const fd = openSync(join(k.conf, 'hub.log'), 'a')
    spawn(process.execPath, [join(k.dir, 'hub.ts')], { stdio: ['ignore', fd, fd], env: { PATH: process.env.PATH!, HOME: k.root, KAGE_ENV: k.envFile, KAGE_CWD: k.work, KAGE_SLACK_API: url, ...env } })
      .on('exit', code => { closeSync(fd); res(code) })
  })
  const logOf = (k: ReturnType<typeof kageCopy>) => readFileSync(join(k.conf, 'hub.log'), 'utf8')

  test('it runs the hub in the working folder and passes on its exit code', async () => {
    const k = kageCopy()
    assert.equal(await hub(k, { FAKE_EXIT: '75' }), 75)
    assert.equal(await hub(k, { FAKE_EXIT: '0' }), 0)
    assert.equal(logOf(k).match(/fake hub up in /g)?.length, 2)
    assert.ok(logOf(k).includes(`fake hub up in ${realpathSync(k.work)}`))
    assert.match(logOf(k), /boom 75[\s\S]*boom 0/)
    rmSync(k.root, { recursive: true })
  })

  test('3 boots in 10 minutes DM the owner once, with the last log lines; a 4th boot in the hour sends nothing', async () => {
    const k = kageCopy()
    calls.length = 0
    await hub(k, { FAKE_EXIT: '1' })
    await hub(k, { FAKE_EXIT: '1' })
    assert.equal(calls.length, 0)
    await hub(k, { FAKE_EXIT: '1' })
    const posts = calls.filter(c => c.path === '/chat.postMessage')
    assert.equal(posts.length, 1)
    assert.equal(posts[0]!.auth, 'Bearer xoxb-test')
    assert.equal(calls.find(c => c.path === '/auth.test')!.auth, 'Bearer xoxp-test')
    const sent = new URLSearchParams(posts[0]!.body)
    assert.equal(sent.get('channel'), 'UOWNER1')
    assert.match(sent.get('text')!, /started 3 times in 10 minutes/)
    assert.match(sent.get('text')!, /boom 1/)
    await hub(k, { FAKE_EXIT: '1' })
    assert.equal(calls.filter(c => c.path === '/chat.postMessage').length, 1)
    rmSync(k.root, { recursive: true })
  })

  test('a hub that cannot even load (a bad pull) exits 1, and the DM quotes the error, not its stack frames', async () => {
    const k = kageCopy()
    writeFileSync(join(k.dir, 'router.ts'), 'this is not ( typescript')
    calls.length = 0
    for (let i = 0; i < 3; i++) assert.equal(await hub(k), 1)
    const text = new URLSearchParams(calls.find(c => c.path === '/chat.postMessage')!.body).get('text')!
    assert.match(text, /ERR_INVALID_TYPESCRIPT_SYNTAX|SyntaxError/)
    assert.doesNotMatch(text, /^\s*at /m)
    rmSync(k.root, { recursive: true })
  })

  test('a hub whose packages are behind the lock runs npm ci once and exits 75, and the next start loads', async () => {
    const k = kageCopy()
    writeFileSync(join(k.dir, 'router.ts'), `import 'fakepkg'; console.log('loaded after npm ci')`)
    const later = new Date(Date.now() + 5000)
    utimesSync(join(k.dir, 'package-lock.json'), later, later)   // the lock moved: packages are behind
    // A stand-in npm that installs the one package and stamps the install, as npm ci does.
    const bin = join(k.root, 'bin')
    mkdirSync(bin)
    writeFileSync(join(bin, 'npm'), `#!/bin/sh\nmkdir -p node_modules/fakepkg && echo '{"name":"fakepkg","main":"i.js"}' > node_modules/fakepkg/package.json && : > node_modules/fakepkg/i.js && touch node_modules/.package-lock.json && echo "npm $*"\n`, { mode: 0o755 })
    assert.equal(await hub(k, { PATH: `${bin}:${process.env.PATH}` }), 75)   // the supervisor starts it again
    assert.equal(await hub(k, { PATH: `${bin}:${process.env.PATH}` }), 0)
    assert.match(logOf(k), /behind package-lock\.json[\s\S]*npm ci --no-audit[\s\S]*loaded after npm ci/)
    assert.equal(logOf(k).match(/npm ci --no-audit/g)?.length, 1)
    rmSync(k.root, { recursive: true })
  })

  test('boots older than 10 minutes do not count toward the alert', async () => {
    const k = kageCopy()
    const old = Math.floor(Date.now() / 1000) - 601
    writeFileSync(join(k.conf, 'boots'), `${old}\n${old}\n`)
    calls.length = 0
    await hub(k, { FAKE_EXIT: '1' })
    assert.equal(calls.length, 0)
    rmSync(k.root, { recursive: true })
  })

  test('a hub.log over 10 MB is copied to hub.log.1 and emptied in place, and the supervisor keeps appending to it', async () => {
    const k = kageCopy()
    writeFileSync(join(k.conf, 'hub.log'), Buffer.alloc(10 * 1024 * 1024 + 1, 'x'))
    await hub(k)
    assert.equal(statSync(join(k.conf, 'hub.log.1')).size, 10 * 1024 * 1024 + 1)
    assert.ok(statSync(join(k.conf, 'hub.log')).size < 4096)
    assert.match(logOf(k), /fake hub up/)
    rmSync(k.root, { recursive: true })
  })

  test('session.env reaches the hub only when the file is private (600)', async () => {
    const k = kageCopy()
    writeFileSync(join(k.dir, 'router.ts'), `console.log('secret=' + (process.env.TEST_SECRET ?? 'none'))`)
    writeFileSync(join(k.conf, 'session.env'), 'TEST_SECRET=s3\n', { mode: 0o644 })
    await hub(k)
    chmodSync(join(k.conf, 'session.env'), 0o600)
    await hub(k)
    assert.match(logOf(k), /not private[\s\S]*secret=none[\s\S]*secret=s3/)
    rmSync(k.root, { recursive: true })
  })

  test('the hub gets the Claude command and the env file path; sessions inherit both', async () => {
    const k = kageCopy()
    writeFileSync(join(k.dir, 'router.ts'), `console.log('claude=' + process.env.KAGE_CLAUDE + ' env=' + process.env.KAGE_ENV)`)
    await hub(k)
    assert.match(logOf(k), /claude=claude --mcp-config .*server\.ts.* --dangerously-load-development-channels server:kage env=.*conf\/env/)
    rmSync(k.root, { recursive: true })
  })

  test('with no env file it says so and exits 0, so the service stays down instead of looping', async () => {
    const k = kageCopy()
    assert.equal(await hub(k, { KAGE_ENV: join(k.conf, 'missing') }), 0)
    assert.match(logOf(k), /kage setup/)
    rmSync(k.root, { recursive: true })
  })
})

describe('service.sh: the unit the OS supervises', () => {
  const text = async (fn: string) => {
    const k = kageCopy()
    const r = await sh(['-c', `source '${join(k.dir, 'service.sh')}'; ${fn}`], { KAGE_ENV: k.envFile, KAGE_CWD: k.work, HOME: k.root })
    rmSync(k.root, { recursive: true })
    return { ...r, k }
  }
  test('the LaunchAgent restarts on a non-zero exit only, every 10 s at most, in the pinned folder', async () => {
    const { out, k } = await text('plist_text')
    assert.match(out, /<key>Label<\/key><string>dev\.kage\.hub\.kagetest<\/string>/)
    assert.match(out, /<key>KeepAlive<\/key><dict><key>SuccessfulExit<\/key><false\/><\/dict>/)
    assert.match(out, /<key>ThrottleInterval<\/key><integer>10<\/integer>/)
    assert.match(out, /<key>RunAtLoad<\/key><true\/>/)
    assert.ok(out.includes(`<string>${k.dir}/hub.ts</string>`))
    assert.ok(out.includes(`<key>StandardOutPath</key><string>${k.conf}/hub.log</string>`))
    assert.ok(out.includes(`<key>WorkingDirectory</key><string>${k.work}</string>`))
    assert.ok(out.includes(`<key>KAGE_ENV</key><string>${k.envFile}</string>`))
    assert.ok(out.includes(`<key>KAGE_CWD</key><string>${k.work}</string>`))
  })
  test('the systemd unit restarts on failure every 10 s with no start limit, in the pinned folder', async () => {
    const { out, k } = await text('unit_text')
    for (const line of ['Restart=on-failure', 'RestartSec=10', 'StartLimitIntervalSec=0', 'WantedBy=default.target',
      `/node" "${k.dir}/hub.ts"`, 'ExecStart="/', `StandardOutput=append:${k.conf}/hub.log`, `WorkingDirectory=${k.work}`, `"KAGE_ENV=${k.envFile}"`, `"KAGE_CWD=${k.work}"`]) {
      assert.ok(out.split('\n').some(l => l.includes(line)), line)
    }
  })
  test('a % in a path is doubled in the unit, because systemd reads % as a specifier', async () => {
    const k = kageCopy()
    const r = await sh(['-c', `source '${join(k.dir, 'service.sh')}'; unit_text`], { KAGE_ENV: k.envFile, KAGE_CWD: '/tmp/a%b', HOME: k.root })
    assert.ok(r.out.includes('WorkingDirectory=/tmp/a%%b'))
    rmSync(k.root, { recursive: true })
  })
  test('a wrong command is refused with the usage line', async () => {
    const k = kageCopy()
    const r = await sh([join(k.dir, 'service.sh'), 'sideways'], { KAGE_ENV: k.envFile, HOME: k.root })
    assert.equal(r.code, 2)
    assert.match(r.out, /Usage/)
    rmSync(k.root, { recursive: true })
  })
})

describe('the hub: one per machine', () => {
  test('a hub started while another answers on the socket exits 0 before it touches the store', async () => {
    const k = kageCopy()
    const { createServer: net } = await import('node:net')
    const sock = join(k.conf, 'router.sock')
    const live = net(s => s.on('data', () => s.write('{"type":"board","live":[]}\n'))).listen(sock)
    await new Promise(r => live.once('listening', r))
    const r = await new Promise<Run>(res => execFile(process.execPath, [join(REPO, 'router.ts')], { env: { PATH: process.env.PATH!, HOME: k.root, KAGE_ENV: k.envFile } },
      (e, so, se) => res({ code: e ? (e.code as number) : 0, out: so + se })))
    live.close()
    assert.equal(r.code, 0)
    assert.match(r.out, /another hub is running/)
    assert.throws(() => statSync(join(k.conf, 'kage.db')))
    rmSync(k.root, { recursive: true })
  })
  test('a hung hub that takes the connect but never answers does not count: the new hub goes on after 2 s', async () => {
    const k = kageCopy()
    const { createServer: net } = await import('node:net')
    const hung = net(() => {}).listen(join(k.conf, 'router.sock'))
    await new Promise(r => hung.once('listening', r))
    const t0 = Date.now()
    // With no KAGE_CLAUDE the hub stops at its next step, which proves it got past the check.
    const r = await new Promise<Run>(res => execFile(process.execPath, [join(REPO, 'router.ts')], { env: { PATH: process.env.PATH!, HOME: k.root, KAGE_ENV: k.envFile } },
      (e, so, se) => res({ code: e ? (e.code as number) : 0, out: so + se })))
    hung.close()
    assert.match(r.out, /KAGE_CLAUDE is not set/)
    assert.doesNotMatch(r.out, /another hub is running/)
    assert.ok(Date.now() - t0 >= 1900, `${Date.now() - t0} ms`)
    rmSync(k.root, { recursive: true })
  })
})

describe('the hub lock: one hub even when two start at the same moment', () => {
  const race = (lock: string, n: number) => Promise.all(Array.from({ length: n }, () => new Promise<string>(res =>
    execFile(process.execPath, ['-e', `import('${join(REPO, 'runtime/hub-lock.ts')}').then(async m => { console.log(await m.hubLock(process.argv[1]) ? 'got' : 'busy'); setTimeout(() => process.exit(0), 1500) })`, lock],
      (_e, so, se) => res(so.trim() || `error: ${se.trim().split('\n')[0]}`)))))
  test('of four started together, exactly one gets it', async () => {
    const k = kageCopy()
    const got = await race(join(k.conf, 'hub.lock'), 4)
    assert.deepEqual(got.sort(), ['busy', 'busy', 'busy', 'got'])
    rmSync(k.root, { recursive: true })
  })
  test('a lock left by a hub that died is taken over, and still by one only', async () => {
    const k = kageCopy()
    const lock = join(k.conf, 'hub.lock')
    // A dead hub leaves its socket file with nobody listening.
    await new Promise<void>(r => execFile(process.execPath, ['-e', `require('node:net').createServer().listen(process.argv[1], () => process.kill(process.pid, 'SIGKILL'))`, lock], () => r()))
    assert.ok(statSync(lock).isSocket())
    const got = await race(lock, 3)
    assert.deepEqual(got.sort(), ['busy', 'busy', 'got'])
    rmSync(k.root, { recursive: true })
  })
})
