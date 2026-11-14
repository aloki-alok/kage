import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { openStore } from '../../runtime/store.ts'
import { wahaIntake } from '../whatsapp.ts'

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
