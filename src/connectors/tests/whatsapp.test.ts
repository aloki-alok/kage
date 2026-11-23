import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { openStore } from '../../runtime/store.ts'
import { bridgeClock, wahaHandler, wahaIntake, wahaSeen, wahaToOwner } from '../whatsapp.ts'
import type { BridgeSeen } from '../../core/whatsapp.ts'

describe('a WhatsApp webhook reaches the inbox before WAHA hears 200', () => {
  const inboxOf = (s: ReturnType<typeof openStore>) => ({ take: (a: string, c: string, p: string | null) => s.take(a, c, p, 1), handled: (a: string) => s.handled(a), has: (a: string) => s.has(a) })
  const store = () => { const s = openStore(':memory:'); return { s, inbox: inboxOf(s) } }
  const event = (id: string) => JSON.stringify({ event: 'message.any', payload: { id, from: '100TEST@c.us', body: 'hi' } })
  test('a message is stored with its id and comes back if never handled', () => {
    const { s, inbox } = store()
    assert.equal(wahaIntake(event('m1'), inbox)?.source, 'wa:m1')
    assert.deepEqual(s.unhandled(0).map(r => [r.source, JSON.parse(r.payload).body]), [['wa:m1', 'hi']])
  })
  test('a redelivered message id runs once, even after a restart', () => {
    const path = `${tmpdir()}/kage-wa-${process.pid}-${Date.now()}.db`
    const first = openStore(path)
    assert.ok(wahaIntake(event('m2'), inboxOf(first)))
    first.close()
    assert.equal(wahaIntake(event('m2'), inboxOf(openStore(path))), undefined)
  })
  test('other events are not stored, and a broken body throws so WAHA hears an error', () => {
    const { s, inbox } = store()
    assert.equal(wahaIntake(JSON.stringify({ event: 'session.status', payload: { id: 'x' } }), inbox), undefined)
    assert.deepEqual(s.unhandled(0), [])
    assert.throws(() => wahaIntake('{not json', inbox))
  })
})

describe('the WAHA webhook refuses a caller before it does any work', () => {
  const HMAC = 'test-hmac-key'
  const sign = (b: string) => createHmac('sha512', HMAC).update(b).digest('hex')
  const event = JSON.stringify({ event: 'message.any', payload: { id: 'm9', from: '100TEST@c.us', body: 'hi' } })
  async function up(max?: number) {
    const s = openStore(':memory:')
    const inbox = { take: (a: string, c: string, p: string | null) => s.take(a, c, p, 1), handled: (a: string) => s.handled(a), has: (a: string) => s.has(a) }
    const ran: string[] = []
    const server = createServer(wahaHandler(HMAC, inbox, (_p, source) => { ran.push(source ?? '') }, max))
    await new Promise<void>(ok => server.listen(0, '127.0.0.1', ok))
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    return { s, ran, url, close: () => server.close() }
  }
  const post = (url: string, body: string, headers: Record<string, string> = {}, path = '/waha') => fetch(url + path, { method: 'POST', body, headers })

  test('no signature header: 401, nothing stored, nothing run', async () => {
    const t = await up()
    assert.equal((await post(t.url, event)).status, 401)
    assert.deepEqual(t.s.unhandled(0), [])
    assert.deepEqual(t.ran, [])
    t.close()
  })
  test('a wrong signature: 401, nothing stored', async () => {
    const t = await up()
    assert.equal((await post(t.url, event, { 'x-webhook-hmac': sign('other') })).status, 401)
    assert.deepEqual(t.s.unhandled(0), [])
    t.close()
  })
  test('the caller is checked before the body is read: an oversized unsigned body gets 401, not 413', async () => {
    const t = await up(1000)
    assert.equal((await post(t.url, 'x'.repeat(5000))).status, 401)
    t.close()
  })
  test('another method or path: 404 even with a good signature', async () => {
    const t = await up()
    assert.equal((await post(t.url, event, { 'x-webhook-hmac': sign(event) }, '/other')).status, 404)
    assert.equal((await fetch(t.url + '/waha', { headers: { 'x-webhook-hmac': sign('') } })).status, 404)
    assert.deepEqual(t.s.unhandled(0), [])
    t.close()
  })
  test('a signed oversized body: 413', async () => {
    const t = await up(1000)
    const big = 'x'.repeat(5000)
    assert.equal((await post(t.url, big, { 'x-webhook-hmac': sign(big) })).status, 413)
    t.close()
  })
  test('a signed event: 200, stored before the answer, then run', async () => {
    const t = await up()
    assert.equal((await post(t.url, event, { 'x-webhook-hmac': sign(event) })).status, 200)
    assert.deepEqual(t.s.unhandled(0).map(r => r.source), ['wa:m9'])
    assert.deepEqual(t.ran, ['wa:m9'])
    t.close()
  })
  test('a handler built with an empty key is refused at build time, so nobody can sign with ""', () => {
    assert.throws(() => wahaHandler('', { take: () => true, handled: () => {}, has: () => false }, () => {}))
  })
})

describe('a look at the WAHA bridge', () => {
  async function waha(answer: (path: string, key?: string) => [number, unknown]) {
    const server = createServer((req, res) => {
      const [code, body] = answer(req.url!, req.headers['x-api-key'] as string | undefined)
      res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(body))
    })
    await new Promise<void>(ok => server.listen(0, '127.0.0.1', ok))
    return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.close() }
  }
  test('pings, then reads the default session with the API key', async () => {
    const seen: string[] = []
    const w = await waha((path, key) => { seen.push(`${path} ${key}`); return path === '/ping' ? [200, { message: 'pong' }] : [200, { name: 'default', status: 'WORKING' }] })
    assert.deepEqual(await wahaSeen(w.url, 'k1'), { reached: true, code: 200, status: 'WORKING' })
    assert.deepEqual(seen, ['/ping k1', '/api/sessions/default k1'])
    w.close()
  })
  test('a refused key comes back as its code', async () => {
    const w = await waha(path => path === '/ping' ? [200, {}] : [401, {}])
    assert.deepEqual(await wahaSeen(w.url, 'bad'), { reached: true, code: 401 })
    w.close()
  })
  test('a bridge that hangs past the timeout is not reached', async () => {
    const server = createServer(() => {})
    await new Promise<void>(ok => server.listen(0, '127.0.0.1', ok))
    assert.deepEqual(await wahaSeen(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, 'k1', 200), { reached: false })
    server.closeAllConnections(); server.close()
  })
  test('a failed ping comes back as its code, and the session is not asked', async () => {
    const seen: string[] = []
    const w = await waha(path => { seen.push(path); return [502, {}] })
    assert.deepEqual(await wahaSeen(w.url, 'k1'), { reached: true, code: 502 })
    assert.deepEqual(seen, ['/ping'])
    w.close()
  })
  test('nothing listening is not reached', async () => {
    const w = await waha(() => [200, {}])
    w.close()
    assert.deepEqual(await wahaSeen(w.url, 'k1'), { reached: false })
  })
})

describe('the hub checks the bridge on its clock and DMs only on a change', () => {
  const at = { url: 'http://127.0.0.1:3198', qr: '/kage/waha/qr.sh' }
  const DOWN: BridgeSeen = { reached: false }, UP: BridgeSeen = { reached: true, code: 200, status: 'WORKING' }
  const STARTING: BridgeSeen = { reached: true, code: 200, status: 'STARTING' }
  function hub(store = openStore(':memory:'), o: { on?: boolean; minutes?: number } = {}) {
    const dms: string[] = []
    let now = UP, slackUp = true
    const jobs = bridgeClock({ on: o.on ?? true, minutes: o.minutes, look: async () => now, at, state: store, notify: async t => { if (slackUp) dms.push(t); return slackUp } })
    return { store, dms, jobs, check: () => jobs[0]!.run(0), set: (s: BridgeSeen) => { now = s }, slack: (up: boolean) => { slackUp = up } }
  }
  test('the job runs every connectors.whatsapp.checkMinutes, 5 when unset', () => {
    assert.equal(hub(undefined, { minutes: 2 }).jobs[0]!.every, 2 * 60_000)
    assert.equal(hub().jobs[0]!.every, 5 * 60_000)
  })
  test('a container restart (STARTING, then WORKING) sends nothing', async () => {
    const h = hub()
    h.set(STARTING); await h.check()
    h.set(UP); await h.check()
    assert.deepEqual(h.dms, [])
  })
  test('STARTING on two looks in a row is down: one DM', async () => {
    const h = hub()
    h.set(STARTING); await h.check(); await h.check(); await h.check()
    assert.equal(h.dms.length, 1)
    assert.match(h.dms[0]!, /STARTING.*wait a minute/)
  })
  test('STARTING while down keeps it down, so WORKING after it says it is back', async () => {
    const h = hub()
    h.set(DOWN); await h.check()
    h.set(STARTING); await h.check()
    assert.equal(h.store.load('whatsapp-bridge-down'), true)
    h.set(UP); await h.check()
    assert.equal(h.dms.length, 2)
    assert.match(h.dms[1]!, /back/)
  })
  test('a DM Slack refused is sent again on the next look, not lost', async () => {
    const h = hub()
    h.slack(false); h.set(DOWN); await h.check()
    assert.equal(h.store.load('whatsapp-bridge-down'), undefined)
    h.slack(true); await h.check()
    assert.equal(h.dms.length, 1)
    assert.match(h.dms[0]!, /down/)
    assert.equal(h.store.load('whatsapp-bridge-down'), true)
  })
  test('WhatsApp turned off while down, then on: no stray back DM', async () => {
    const first = hub()
    first.set(DOWN); await first.check()
    assert.deepEqual(hub(first.store, { on: false }).jobs, [])
    const again = hub(first.store)
    await again.check()
    assert.deepEqual(again.dms, [])
  })
  test('down, down, up, up: one DM down and one back', async () => {
    const h = hub()
    h.set(DOWN); await h.check(); await h.check()
    h.set(UP); await h.check(); await h.check()
    assert.equal(h.dms.length, 2)
    assert.match(h.dms[0]!, /down.*docker start kage-waha/)
    assert.match(h.dms[1]!, /back/)
  })
  test('a hub that restarts while the bridge is still down does not DM again', async () => {
    const first = hub()
    first.set(DOWN); await first.check()
    const second = hub(first.store)
    second.set(DOWN); await second.check()
    assert.deepEqual(second.dms, [])
    second.set(UP); await second.check()
    assert.equal(second.dms.length, 1)
  })
  test('a bridge that was always up never DMs', async () => {
    const h = hub()
    for (let i = 0; i < 5; i++) await h.check()
    assert.deepEqual(h.dms, [])
    assert.equal(h.store.load('whatsapp-bridge-down'), undefined)
    h.set(DOWN); await h.check()
    assert.equal(h.dms.length, 1)
  })
})

describe("a message to the owner on WhatsApp (#423)", () => {
  async function waha(me: unknown, sendCode = 201) {
    const seen: { path: string; key?: string; body?: { chatId: string; text: string; session: string } }[] = []
    const server = createServer((req, res) => {
      let raw = ''
      req.on('data', c => { raw += c })
      req.on('end', () => {
        seen.push({ path: req.url!, key: req.headers['x-api-key'] as string | undefined, ...(raw && { body: JSON.parse(raw) }) })
        const [code, body] = req.url === '/api/sessions/default/me' ? [200, me] : [sendCode, { id: 'm1' }]
        res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(body))
      })
    })
    await new Promise<void>(ok => server.listen(0, '127.0.0.1', ok))
    server.unref()
    return { seen, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.close() }
  }
  test("goes to the owner's own chat, signed as Kage, with the account looked up on each send so a relinked phone gets it", async () => {
    const w = await waha({ id: '100OWNER@c.us', pushName: 'Owner' })
    const say = wahaToOwner(w.url, 'k1', 'Kage', 'kage')
    assert.equal(await say('the deploy failed'), true)
    assert.equal(await say('again'), true)
    assert.deepEqual(w.seen.map(x => x.path), ['/api/sessions/default/me', '/api/sendText', '/api/sessions/default/me', '/api/sendText'])
    assert.equal(w.seen[1]!.body!.chatId, '100OWNER@c.us')
    assert.match(w.seen[1]!.body!.text, /^the deploy failed\n\n_.*Kage/)
    assert.ok(w.seen.every(x => x.key === 'k1'))
    w.close()
  })
  test('a bridge with no linked phone, or a refused send, is a failed send', async () => {
    const none = await waha({})
    assert.equal(await wahaToOwner(none.url, 'k1', 'Kage', 'kage')('hi'), false)
    none.close()
    const refused = await waha({ id: '100OWNER@c.us' }, 500)
    assert.equal(await wahaToOwner(refused.url, 'k1', 'Kage', 'kage')('hi'), false)
    const secret = await waha({ id: '100OWNER@c.us' })
    assert.equal(await wahaToOwner(secret.url, 'k1', 'Kage', 'kage')('key AKIAIOSFODNN7EXAMPLE'), false)
    assert.deepEqual(secret.seen, [], 'a secret never reaches the bridge')
    secret.close()
    refused.close()
  })
})
