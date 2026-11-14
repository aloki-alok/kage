import { describe, test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, statSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { held, hold, keyProxy } from '../key-proxy.ts'

const open: { close(): void }[] = []
afterEach(() => { open.splice(0).forEach(r => r.close()) })

type Call = { url: string; init: RequestInit }
// A fake upstream: records what the hub would send over the network, and answers 201.
function setup(trusted = (_k: string) => true) {
  const calls: Call[] = []
  const sock = join(mkdtempSync(join(tmpdir(), 'kage-keys-')), 'keys.sock')
  const p = keyProxy({
    path: sock, trusted, log: () => {},
    routes: { API_KEY: { host: 'api.example.test', header: 'x-api-key', prefix: '' }, OTHER: { host: 'other.example.test' } },
    values: new Map([['API_KEY', 'fake-key-1'], ['OTHER', 'fake-key-2']]),
    fetch: async (url: string, init: RequestInit) => { calls.push({ url, init }); return new Response('upstream-body', { status: 201, headers: { 'x-up': '1' } }) },
  })
  open.push(p)
  return { p, sock, calls }
}
function get(sock: string, path: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; body: string }>((ok, no) => {
    const r = request({ socketPath: sock, path, method: 'POST', headers }, res => {
      let body = ''; res.on('data', d => { body += d }); res.on('end', () => ok({ status: res.statusCode!, body }))
    })
    r.on('error', no); r.end('payload')
  })
}
const sent = (c: Call) => new Headers(c.init.headers)

describe('the key proxy', () => {
  test('the allowed host gets the key in its header, the client header is replaced, and the answer comes back', async () => {
    const t = setup()
    const token = t.p.issue('C1:5.5')!
    const r = await get(t.sock, `/${token}/api.example.test/v1/x?y=1`, { 'x-api-key': 'client-lie', 'x-keep': 'yes' })
    assert.equal(r.status, 201)
    assert.equal(r.body, 'upstream-body')
    assert.equal(t.calls.length, 1)
    assert.equal(t.calls[0]!.url, 'https://api.example.test/v1/x?y=1')
    assert.equal(sent(t.calls[0]!).get('x-api-key'), 'fake-key-1')
    assert.equal(sent(t.calls[0]!).get('x-keep'), 'yes')
    assert.ok(!JSON.stringify([...sent(t.calls[0]!)]).includes('fake-key-2'), 'the other host key leaked')
    assert.equal(t.calls[0]!.init.redirect, 'manual')   // a redirect never carries the key to another host
  })
  test('another host is refused and nothing is fetched', async () => {
    const t = setup()
    const token = t.p.issue('C1:5.5')!
    for (const host of ['evil.example.test', 'api.example.test.evil.test', 'api.example.test@evil.test', 'x.api.example.test', 'xapi.example.test', 'api.example.test.', 'API.EXAMPLE.TEST', 'api.example.test%2f.evil.test']) {
      const r = await get(t.sock, `/${token}/${host}/x`)
      assert.equal(r.status, 403, host)
    }
    assert.equal(t.calls.length, 0)
  })
  test('a wrong token, an untrusted thread and a dropped token get nothing', async () => {
    let ok = true
    const t = setup(() => ok)
    const token = t.p.issue('C1:5.5')!
    assert.equal((await get(t.sock, `/nope/api.example.test/x`)).status, 403)
    ok = false
    assert.equal((await get(t.sock, `/${token}/api.example.test/x`)).status, 403)
    ok = true
    t.p.drop('C1:5.5')
    assert.equal((await get(t.sock, `/${token}/api.example.test/x`)).status, 403)
    assert.equal(t.calls.length, 0)
  })
  test('a new issue replaces the old token for the same thread', async () => {
    const t = setup()
    const old = t.p.issue('C1:5.5')!
    const fresh = t.p.issue('C1:5.5')!
    assert.notEqual(old, fresh)
    assert.equal((await get(t.sock, `/${old}/api.example.test/x`)).status, 403)
    assert.equal((await get(t.sock, `/${fresh}/api.example.test/x`)).status, 201)
  })
  test('issue gives no token to a thread that is not a trusted Slack thread', () => {
    assert.equal(setup(() => false).p.issue('C1:5.5'), undefined)
    assert.equal(setup().p.issue('mail:abc'), undefined)
  })
  test('the socket is private to the owner', () => {
    assert.equal(statSync(setup().sock).mode & 0o777, 0o600)
  })
})

test('hold moves a named key out of the process environment and keeps it in memory', () => {
  process.env.FAKE_HELD_KEY = 'fake-value'
  process.env.FAKE_OTHER = 'stays'
  hold(['FAKE_HELD_KEY', 'FAKE_MISSING'])
  assert.equal(process.env.FAKE_HELD_KEY, undefined)
  assert.equal(held.get('FAKE_HELD_KEY'), 'fake-value')
  assert.equal(process.env.FAKE_OTHER, 'stays')
  assert.ok(!held.has('FAKE_MISSING'))
  delete process.env.FAKE_OTHER
})
