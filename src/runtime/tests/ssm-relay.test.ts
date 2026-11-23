import { describe, test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { findPlugin, ssmRelay } from '../ssm-relay.ts'
import { openStore } from '../store.ts'

const ID = 'i-0123456789abcdef0'
const logs: string[] = []
const open: { close(): void }[] = []
afterEach(() => { open.splice(0).forEach(r => r.close()) })

const call = (region = 'us-west-1', op = 'StartSession') => [
  JSON.stringify({ SessionId: 's-1', TokenValue: 'tv-secret', StreamUrl: `wss://ssmmessages.${region}.amazonaws.com/v1/data-channel/s-1` }),
  region, op, '', JSON.stringify({ Target: ID, DocumentName: 'AWS-StartSSHSession', Parameters: { portNumber: ['22'] } }), `https://ssm.${region}.amazonaws.com`]
const header = (token: string, args = call()) => JSON.stringify({ token, args })

function setup(o: { max?: number; trusted?: (k: string) => boolean; plugin?: string | undefined } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'kage-ssm-'))
  const plugin = join(dir, 'session-manager-plugin')
  writeFileSync(plugin, `#!/usr/bin/env node\nrequire('node:fs').appendFileSync(${JSON.stringify(dir + '/args')}, JSON.stringify(process.argv.slice(2)) + '\\n')\nprocess.stdin.pipe(process.stdout)\n`)
  chmodSync(plugin, 0o755)
  const sock = join(dir, 'ssm.sock')
  const relay = ssmRelay({ path: sock, plugin: 'plugin' in o ? o.plugin : plugin, max: o.max, trusted: o.trusted ?? (() => true), log: (...a) => logs.push(a.join(' ')) })
  open.push(relay)
  return { dir, sock, relay, args: () => existsSync(join(dir, 'args')) ? readFileSync(join(dir, 'args'), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l) as string[]) : [] }
}
async function client(sock: string, header: string) {
  const s = await new Promise<ReturnType<typeof connect>>((ok, no) => { const c = connect(sock, () => ok(c)); c.on('error', no) })
  let buf = ''
  const waiters: (() => void)[] = []
  s.on('data', d => { buf += d; waiters.splice(0).forEach(w => w()) })
  s.on('close', () => waiters.splice(0).forEach(w => w()))
  s.write(header + '\n')
  const until = async (re: RegExp) => { for (let i = 0; i < 200 && !re.test(buf); i++) await new Promise<void>(r => { waiters.push(r); setTimeout(r, 25) }); return buf }
  return { s, until, text: () => buf }
}

describe('finding the real plugin', () => {
  test('the first executable on the hub PATH wins, and the stand-in folder is skipped', () => {
    const [a, b] = [mkdtempSync(join(tmpdir(), 'kage-a-')), mkdtempSync(join(tmpdir(), 'kage-b-'))]
    for (const d of [a, b]) { writeFileSync(`${d}/session-manager-plugin`, '#!/bin/sh\n'); chmodSync(`${d}/session-manager-plugin`, 0o755) }
    assert.equal(findPlugin(`${a}:${b}`), `${a}/session-manager-plugin`)
    assert.equal(findPlugin(`${a}:${b}`, [a]), `${b}/session-manager-plugin`)
    assert.equal(findPlugin(`${a}`, [a], []), undefined)
    assert.equal(findPlugin('', [], []), undefined)
  })
  test('a LaunchAgent PATH without Homebrew still finds the plugin in its install folder, after anything on PATH', () => {
    const [onPath, brew, empty] = [mkdtempSync(join(tmpdir(), 'kage-p-')), mkdtempSync(join(tmpdir(), 'kage-brew-')), mkdtempSync(join(tmpdir(), 'kage-e-'))]
    for (const d of [onPath, brew]) { writeFileSync(`${d}/session-manager-plugin`, '#!/bin/sh\n'); chmodSync(`${d}/session-manager-plugin`, 0o755) }
    assert.equal(findPlugin(`/usr/bin:${empty}`, [], [brew]), `${brew}/session-manager-plugin`)
    assert.equal(findPlugin(onPath, [], [brew]), `${onPath}/session-manager-plugin`)
    assert.equal(findPlugin('/usr/bin', [brew], [brew]), undefined)
  })
})

describe('the SSM relay', () => {
  test('bytes pipe both ways through the real plugin, which gets exactly the arguments aws sent', async () => {
    const t = setup()
    const token = t.relay.issue('C1:5.5')!
    const c = await client(t.sock, header(token))
    assert.match(await c.until(/^ok\n/), /^ok\n/)
    c.s.write('ping-1\n')
    assert.match(await c.until(/ping-1\n/), /ping-1/)
    c.s.write('ping-2\n')
    assert.match(await c.until(/ping-2\n/), /ping-2/)
    c.s.end()
    assert.deepEqual(t.args(), [call()])
    for (let i = 0; i < 100 && !logs.some(l => l.includes('exit')); i++) await new Promise(r => setTimeout(r, 20))
    const line = logs.find(l => l.includes(ID))!
    assert.match(line, /us-west-1/)
    assert.match(line, /exit/)
    assert.ok(!line.includes('ping') && !line.includes(token) && !line.includes('tv-secret') && !line.includes('wss://'))
  })
  test('the socket is private to the owner', () => {
    const t = setup()
    assert.equal(statSync(t.sock).mode & 0o777, 0o600)
  })
  test('a wrong token, another operation, a foreign stream host and a bad header are refused, and the plugin never runs', async () => {
    const t = setup()
    const token = t.relay.issue('C1:5.5')!
    const foreign = call(); foreign[0] = JSON.stringify({ StreamUrl: 'wss://evil.example.com/x' })
    for (const h of [header('nope'), header(token, call('us-west-1', 'TerminateSession')), header(token, foreign), JSON.stringify({ token, args: 'x' }), 'garbage', JSON.stringify({ args: call() })]) {
      const c = await client(t.sock, h)
      assert.match(await c.until(/\n/), /^error: /, h)
    }
    assert.deepEqual(t.args(), [])
  })
  test('with no real plugin on the hub PATH, a session is told so and nothing runs', async () => {
    const t = setup({ plugin: undefined })
    const c = await client(t.sock, header(t.relay.issue('C1:5.5')!))
    assert.match(await c.until(/\n/), /^error: session-manager-plugin is not on the hub/)
  })
  test('only an owner thread gets a token, and a thread that lost trust since is refused at connect', async () => {
    let trust = true
    const t = setup({ trusted: () => trust })
    assert.equal(t.relay.issue('mail:abc'), undefined)
    assert.equal(t.relay.issue('voice:abc'), undefined)
    const token = t.relay.issue('C1:5.5')!
    trust = false
    assert.equal(t.relay.issue('C2:5.5'), undefined)
    const c = await client(t.sock, header(token))
    assert.match(await c.until(/\n/), /^error: /)
    assert.deepEqual(t.args(), [])
  })
  test('a listed teammate thread gets a token and passes at connect, deny removes both, an unlisted one and a kagelet lane are refused', async () => {
    const store = openStore(':memory:')
    store.setTrust('C9:1.1', false)
    const t = setup({ trusted: k => store.relayOk(k) })
    assert.equal(t.relay.issue('C9:1.1'), undefined)
    store.setRelayAllow('C9:1.1', true)
    assert.equal(t.relay.issue('C9:1.1#side-kagelet-mon'), undefined)
    const token = t.relay.issue('C9:1.1')!
    assert.ok(token)
    const ok = await client(t.sock, header(token))
    assert.match(await ok.until(/^ok\n/), /^ok\n/)
    ok.s.end()
    store.setRelayAllow('C9:1.1', false)
    assert.equal(t.relay.issue('C9:1.1'), undefined)
    const c = await client(t.sock, header(token))
    assert.match(await c.until(/\n/), /^error: /)
  })
  test('a dropped session token stops working', async () => {
    const t = setup()
    const token = t.relay.issue('C1:5.5')!
    t.relay.drop('C1:5.5')
    const c = await client(t.sock, header(token))
    assert.match(await c.until(/\n/), /^error: /)
  })
  test('relays beyond the cap are refused until one ends', async () => {
    const t = setup({ max: 1 })
    const token = t.relay.issue('C1:5.5')!
    const a = await client(t.sock, header(token))
    await a.until(/^ok\n/)
    const b = await client(t.sock, header(token))
    assert.match(await b.until(/\n/), /^error: too many/)
    a.s.end()
    for (let i = 0; i < 100; i++) {
      const c = await client(t.sock, header(token))
      if (/^ok\n/.test(await c.until(/\n/))) { c.s.end(); return }
      await new Promise(r => setTimeout(r, 30))
    }
    assert.fail('the cap never freed')
  })
})

const SHIM = join(import.meta.dirname, '../../cli/ssm-plugin-shim/session-manager-plugin')
describe('the stand-in session-manager-plugin', () => {
  const run = (args: string[], env: Record<string, string>, input = '') => new Promise<{ out: string; err: string; code: number | null }>(ok => {
    const p = execFile('node', [SHIM, ...args], { env: { PATH: process.env.PATH!, ...env } }, (_e, out, err) => ok({ out, err, code: p.exitCode }))
    p.stdin!.end(input)
  })
  test('it pipes stdin and stdout through the hub when the token is accepted', async () => {
    const t = setup()
    const token = t.relay.issue('C1:5.5')!
    const good = await run(call(), { KAGE_SSM_SOCK: t.sock, KAGE_SSM_TOKEN: token }, 'SSH-2.0-test\n')
    assert.deepEqual([good.out, good.code], ['SSH-2.0-test\n', 0])
    assert.deepEqual(t.args(), [call()])
  })
  test('aws gives a new plugin the response in an env var, and the hub still gets the JSON', async () => {
    const t = setup()
    const token = t.relay.issue('C1:5.5')!
    const [response, ...more] = call()
    const r = await run(['AWS_SSM_START_SESSION_RESPONSE', ...more], { AWS_SSM_START_SESSION_RESPONSE: response!, KAGE_SSM_SOCK: t.sock, KAGE_SSM_TOKEN: token }, 'x\n')
    assert.deepEqual([r.out, r.code], ['x\n', 0])
    assert.deepEqual(t.args(), [call()])
  })
  test('--version answers without a token, so aws goes on to the call', async () => {
    const r = await run(['--version'], {})
    assert.equal(r.code, 0)
    assert.match(r.out, /^\d+(\.\d+){1,3}\n$/)
  })
  test('with no token it refuses, says why, and writes nothing to stdout', async () => {
    const none = await run(call(), {})
    assert.deepEqual([none.out, none.code], ['', 1])
    assert.match(none.err, /KAGE_SSM_TOKEN/)
  })
  test('a refused call exits 1 with the hub reason on stderr and nothing on stdout', async () => {
    const t = setup()
    const bad = await run(call(), { KAGE_SSM_SOCK: t.sock, KAGE_SSM_TOKEN: 'wrong' }, 'x')
    assert.deepEqual([bad.out, bad.code], ['', 1])
    assert.match(bad.err, /kage ssm: no relay for this session/)
    assert.deepEqual(t.args(), [])
  })
})
