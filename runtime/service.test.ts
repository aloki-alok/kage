// The scripts that keep the hub alive (run.sh, service.sh), run for real from a temp copy with a fake
// hub (router.ts) and a fake Slack API. Nothing here talks to Slack, launchd or systemd.
import { describe, test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmodSync, copyFileSync, mkdirSync, realpathSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REPO = join(import.meta.dirname, '..')
const FAKE_HUB = `console.log('fake hub up in ' + process.cwd()); console.error('boom ' + process.env.FAKE_EXIT); process.exit(Number(process.env.FAKE_EXIT ?? 0))`

type Run = { code: number | null; out: string }
const sh = (args: string[], env: Record<string, string>): Promise<Run> => new Promise(res =>
  execFile('bash', args, { env: { PATH: process.env.PATH!, HOME: env.HOME ?? tmpdir(), ...env } }, (e, stdout, stderr) =>
    res({ code: e ? (typeof e.code === 'number' ? e.code : null) : 0, out: stdout + stderr })))

// A Kage folder with the real scripts and a fake hub, and a config folder with an env file.
function kageCopy() {
  const root = mkdtempSync(join(tmpdir(), 'kage-svc-'))
  const dir = join(root, 'code'), conf = join(root, 'conf'), work = join(root, 'work')
  for (const d of [dir, conf, work, join(dir, 'node_modules')]) mkdirSync(d, { recursive: true })
  for (const f of ['run.sh', 'service.sh']) copyFileSync(join(REPO, f), join(dir, f))
  writeFileSync(join(dir, 'router.ts'), FAKE_HUB)
  // The packages are current: the lock is older than npm's stamp, so run.sh skips npm ci.
  writeFileSync(join(dir, 'package-lock.json'), '{}')
  utimesSync(join(dir, 'package-lock.json'), new Date(0), new Date(0))
  writeFileSync(join(dir, 'node_modules', '.package-lock.json'), '{}')
  const envFile = join(conf, 'env')
  writeFileSync(envFile, 'KAGE_NAME=kagetest\nSLACK_APP_TOKEN=xapp-test\nSLACK_USER_TOKEN=xoxp-test\nSLACK_BOT_TOKEN=xoxb-test\n', { mode: 0o600 })
  return { root, dir, conf, work, envFile }
}

describe('run.sh: one hub run, with its log, its boot count and a crash-loop DM', () => {
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

  test('it runs the hub in the working folder, appends its output to hub.log, and passes on its exit code', async () => {
    const k = kageCopy()
    const env = { KAGE_ENV: k.envFile, KAGE_CWD: k.work, KAGE_SLACK_API: url }
    assert.equal((await sh([join(k.dir, 'run.sh')], { ...env, FAKE_EXIT: '75' })).code, 75)
    assert.equal((await sh([join(k.dir, 'run.sh')], { ...env, FAKE_EXIT: '0' })).code, 0)
    const log = readFileSync(join(k.conf, 'hub.log'), 'utf8')
    assert.equal(log.match(/fake hub up in /g)?.length, 2)
    assert.ok(log.includes(`fake hub up in ${realpathSync(k.work)}`))
    assert.match(log, /boom 75[\s\S]*boom 0/)
    rmSync(k.root, { recursive: true })
  })

  test('3 boots in 10 minutes DM the owner once, with the last log lines; a 4th boot in the hour sends nothing', async () => {
    const k = kageCopy()
    const env = { KAGE_ENV: k.envFile, KAGE_CWD: k.work, KAGE_SLACK_API: url, FAKE_EXIT: '1' }
    calls.length = 0
    await sh([join(k.dir, 'run.sh')], env)
    await sh([join(k.dir, 'run.sh')], env)
    assert.equal(calls.length, 0)
    await sh([join(k.dir, 'run.sh')], env)
    const posts = calls.filter(c => c.path === '/chat.postMessage')
    assert.equal(posts.length, 1)
    assert.equal(posts[0]!.auth, 'Bearer xoxb-test')
    assert.equal(calls.find(c => c.path === '/auth.test')!.auth, 'Bearer xoxp-test')
    const sent = new URLSearchParams(posts[0]!.body)
    assert.equal(sent.get('channel'), 'UOWNER1')
    assert.match(sent.get('text')!, /started 3 times in 10 minutes/)
    assert.match(sent.get('text')!, /boom 1/)
    await sh([join(k.dir, 'run.sh')], env)
    assert.equal(calls.filter(c => c.path === '/chat.postMessage').length, 1)
    rmSync(k.root, { recursive: true })
  })

  test('boots older than 10 minutes do not count toward the alert', async () => {
    const k = kageCopy()
    const old = Math.floor(Date.now() / 1000) - 601
    writeFileSync(join(k.conf, 'boots'), `${old}\n${old}\n`)
    calls.length = 0
    await sh([join(k.dir, 'run.sh')], { KAGE_ENV: k.envFile, KAGE_CWD: k.work, KAGE_SLACK_API: url, FAKE_EXIT: '1' })
    assert.equal(calls.length, 0)
    rmSync(k.root, { recursive: true })
  })

  test('a hub.log over 10 MB moves to hub.log.1 before the run', async () => {
    const k = kageCopy()
    writeFileSync(join(k.conf, 'hub.log'), Buffer.alloc(10 * 1024 * 1024 + 1, 'x'))
    await sh([join(k.dir, 'run.sh')], { KAGE_ENV: k.envFile, KAGE_CWD: k.work, KAGE_SLACK_API: url })
    assert.equal(statSync(join(k.conf, 'hub.log.1')).size, 10 * 1024 * 1024 + 1)
    assert.match(readFileSync(join(k.conf, 'hub.log'), 'utf8'), /fake hub up/)
    rmSync(k.root, { recursive: true })
  })

  test('session.env reaches the hub only when the file is private (600)', async () => {
    const k = kageCopy()
    writeFileSync(join(k.dir, 'router.ts'), `console.log('secret=' + (process.env.TEST_SECRET ?? 'none'))`)
    const env = { KAGE_ENV: k.envFile, KAGE_CWD: k.work, KAGE_SLACK_API: url }
    writeFileSync(join(k.conf, 'session.env'), 'TEST_SECRET=s3\n', { mode: 0o644 })
    await sh([join(k.dir, 'run.sh')], env)
    chmodSync(join(k.conf, 'session.env'), 0o600)
    await sh([join(k.dir, 'run.sh')], env)
    const log = readFileSync(join(k.conf, 'hub.log'), 'utf8')
    assert.match(log, /not private[\s\S]*secret=none[\s\S]*secret=s3/)
    rmSync(k.root, { recursive: true })
  })

  test('with no env file it says so and exits 0, so the service stays down instead of looping', async () => {
    const k = kageCopy()
    const r = await sh([join(k.dir, 'run.sh')], { KAGE_ENV: join(k.conf, 'missing'), KAGE_CWD: k.work, KAGE_SLACK_API: url })
    assert.equal(r.code, 0)
    assert.match(r.out, /kage setup/)
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
    assert.ok(out.includes(`<string>${k.dir}/run.sh</string>`))
    assert.ok(out.includes(`<key>WorkingDirectory</key><string>${k.work}</string>`))
    assert.ok(out.includes(`<key>KAGE_ENV</key><string>${k.envFile}</string>`))
    assert.ok(out.includes(`<key>KAGE_CWD</key><string>${k.work}</string>`))
  })
  test('the systemd unit restarts on failure every 10 s with no start limit, in the pinned folder', async () => {
    const { out, k } = await text('unit_text')
    for (const line of ['Restart=on-failure', 'RestartSec=10', 'StartLimitIntervalSec=0', 'WantedBy=default.target',
      `ExecStart="${k.dir}/run.sh"`, `WorkingDirectory=${k.work}`, `"KAGE_ENV=${k.envFile}"`, `"KAGE_CWD=${k.work}"`]) {
      assert.ok(out.split('\n').some(l => l.includes(line)), line)
    }
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
