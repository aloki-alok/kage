import { describe, test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { ssmRelay } from '../ssm-relay.ts'
import { openStore } from '../store.ts'

const ID = 'i-0123456789abcdef0'
const logs: string[] = []
const open: { close(): void }[] = []
afterEach(() => { open.splice(0).forEach(r => r.close()) })

// A fake aws that records its arguments, then echoes stdin to stdout like a tunnel to an echo server.
function setup(o: { max?: number; trusted?: (k: string) => boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'kage-ssm-'))
  const aws = join(dir, 'aws')
  writeFileSync(aws, `#!/bin/sh\necho "$@" >> ${dir}/args\nexec cat\n`)
  chmodSync(aws, 0o755)
  const sock = join(dir, 'ssm.sock')
  const relay = ssmRelay({ path: sock, aws, max: o.max, trusted: o.trusted ?? (() => true), log: (...a) => logs.push(a.join(' ')) })
  open.push(relay)
  return { dir, sock, relay, args: () => existsSync(join(dir, 'args')) ? readFileSync(join(dir, 'args'), 'utf8') : '' }
}
// Connect, send a header line, and return the socket with a reader for what comes back.
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

describe('the SSM relay', () => {
  test('bytes pipe both ways through aws, and the command line is fixed', async () => {
    const t = setup()
    const token = t.relay.issue('C1:5.5')!
    const c = await client(t.sock, `${token} ${ID} 22 us-west-1`)
    assert.match(await c.until(/^ok\n/), /^ok\n/)
    c.s.write('ping-1\n')
    assert.match(await c.until(/ping-1\n/), /ping-1/)
    c.s.write('ping-2\n')
    assert.match(await c.until(/ping-2\n/), /ping-2/)
    c.s.end()
    assert.equal(t.args().trim(), `ssm start-session --target ${ID} --document-name AWS-StartSSHSession --parameters portNumber=22 --region us-west-1`)
    for (let i = 0; i < 100 && !logs.some(l => l.includes('exit')); i++) await new Promise(r => setTimeout(r, 20))
    const line = logs.find(l => l.includes(ID))!
    assert.match(line, /exit/)
    assert.ok(!line.includes('ping'))
  })
  test('the socket is private to the owner', () => {
    const t = setup()
    assert.equal(statSync(t.sock).mode & 0o777, 0o600)
  })
  test('a wrong token, a bad target and a bad port are refused, and aws never runs', async () => {
    const t = setup()
    const token = t.relay.issue('C1:5.5')!
    for (const h of [`nope ${ID} 22`, `${token} myhost 22`, `${token} ${ID} 99999`, `${token} ${ID};id 22`, 'garbage']) {
      const c = await client(t.sock, h)
      assert.match(await c.until(/\n/), /^error: /, h)
    }
    assert.equal(t.args(), '')
  })
  test('only an owner thread gets a token, and a thread that lost trust since is refused at connect', async () => {
    let trust = true
    const t = setup({ trusted: () => trust })
    assert.equal(t.relay.issue('mail:abc'), undefined)
    assert.equal(t.relay.issue('voice:abc'), undefined)
    const token = t.relay.issue('C1:5.5')!
    trust = false
    assert.equal(t.relay.issue('C2:5.5'), undefined)
    const c = await client(t.sock, `${token} ${ID} 22`)
    assert.match(await c.until(/\n/), /^error: /)
    assert.equal(t.args(), '')
  })
  test('a listed teammate thread gets a token and passes at connect, deny removes both, an unlisted one and a kagelet lane are refused', async () => {
    const store = openStore(':memory:')
    store.setTrust('C9:1.1', false)
    const t = setup({ trusted: k => store.relayOk(k) })
    assert.equal(t.relay.issue('C9:1.1'), undefined)               // teammate thread, not listed
    store.setRelayAllow('C9:1.1', true)
    assert.equal(t.relay.issue('C9:1.1#side-kagelet-mon'), undefined)   // a lane of a listed thread
    const token = t.relay.issue('C9:1.1')!
    assert.ok(token)
    const ok = await client(t.sock, `${token} ${ID} 22`)
    assert.match(await ok.until(/^ok\n/), /^ok\n/)
    ok.s.end()
    store.setRelayAllow('C9:1.1', false)
    assert.equal(t.relay.issue('C9:1.1'), undefined)               // no new token
    const c = await client(t.sock, `${token} ${ID} 22`)            // the old token fails at connect
    assert.match(await c.until(/\n/), /^error: /)
  })
  test('a dropped session token stops working', async () => {
    const t = setup()
    const token = t.relay.issue('C1:5.5')!
    t.relay.drop('C1:5.5')
    const c = await client(t.sock, `${token} ${ID} 22`)
    assert.match(await c.until(/\n/), /^error: /)
  })
  test('relays beyond the cap are refused until one ends', async () => {
    const t = setup({ max: 1 })
    const token = t.relay.issue('C1:5.5')!
    const a = await client(t.sock, `${token} ${ID} 22`)
    await a.until(/^ok\n/)
    const b = await client(t.sock, `${token} ${ID} 22`)
    assert.match(await b.until(/\n/), /^error: too many/)
    a.s.end()
    for (let i = 0; i < 100; i++) {
      const c = await client(t.sock, `${token} ${ID} 22`)
      if (/^ok\n/.test(await c.until(/\n/))) { c.s.end(); return }
      await new Promise(r => setTimeout(r, 30))
    }
    assert.fail('the cap never freed')
  })
  test('the ProxyCommand client pipes stdin and stdout, and exits 1 with nothing on stdout when refused', async () => {
    const t = setup()
    const token = t.relay.issue('C1:5.5')!
    const run = (tok: string, input: string) => new Promise<{ out: string; err: string; code: number | null }>(ok => {
      const p = execFile('node', [join(import.meta.dirname, '../../cli/ssm-proxy.ts'), ID, '22', 'us-west-1'], { env: { ...process.env, KAGE_SSM_SOCK: t.sock, KAGE_SSM_TOKEN: tok } }, (e, out, err) => ok({ out, err, code: p.exitCode }))
      p.stdin!.end(input)
    })
    const good = await run(token, 'SSH-2.0-test\n')
    assert.deepEqual([good.out, good.code], ['SSH-2.0-test\n', 0])
    const bad = await run('wrong', 'x')
    assert.deepEqual([bad.out, bad.code], ['', 1])
    assert.match(bad.err, /kage ssm: no relay for this session/)
    const none = await new Promise<{ err: string; code: number | null }>(ok => { const p = execFile('node', [join(import.meta.dirname, '../../cli/ssm-proxy.ts'), ID, '22'], { env: { PATH: process.env.PATH } }, (e, o, err) => ok({ err, code: p.exitCode })); p.stdin!.end() })
    assert.equal(none.code, 1)
    assert.match(none.err, /KAGE_SSM_TOKEN/)
  })
})
