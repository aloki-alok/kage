import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { openStore } from '../../runtime/store.ts'
import { wahaHandler, wahaIntake } from '../whatsapp.ts'

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
})
