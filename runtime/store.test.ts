import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { openStore } from './store.ts'

const DM = 'DBOT00001'

describe('the store', () => {
  test('a conversation is saved once by key, with its place, and its last activity moves forward', () => {
    const s = openStore(':memory:')
    const c = { connector: 'slack', chat: 'C1', thread: '5.5', kind: 'channel' } as const
    s.seen('C1:5.5', c, '#general', 100)
    s.seen('C1:5.5', c, '#general-renamed', 200)
    assert.deepEqual(s.conversation('C1:5.5'), { key: 'C1:5.5', conversation: c, place: '#general-renamed', firstSeen: 100, lastSeen: 200 })
  })
  test('each conversation keeps its session id for good, and a restart reads them all back', () => {
    const path = `${process.env.TMPDIR ?? '/tmp'}/kage-store-${process.pid}-${Date.now()}.db`
    const a = openStore(path)
    a.saveSessions({ 'C1:5.5': 'id-1', dm: 'id-2' })
    a.saveSessions({ 'C1:5.5': 'id-1', dm: 'id-2', 'mail:<r@x>': 'id-3' })
    a.close()
    assert.deepEqual(openStore(path).sessions(), { 'C1:5.5': 'id-1', dm: 'id-2', 'mail:<r@x>': 'id-3' })
  })
  test('a session whose transcript is gone can be forgotten', () => {
    const s = openStore(':memory:')
    s.saveSessions({ a: '1', b: '2' })
    s.forget('a')
    assert.deepEqual(s.sessions(), { b: '2' })
  })
  test('threads.json from before the store is imported once, keys and session ids unchanged', () => {
    const s = openStore(':memory:')
    const old = { 'C1:5.5': 'id-1', dm: 'id-2', 'mail:<r@x>': 'id-3', 'wa:91@c.us': 'id-4', 'C1:5.5#side-6.6': 'id-5', junk: 'id-6' }
    const r = s.importThreads(old, DM, 50)
    assert.deepEqual(r, { imported: 5, skipped: ['junk'] })
    assert.deepEqual(s.sessions(), { 'C1:5.5': 'id-1', dm: 'id-2', 'mail:<r@x>': 'id-3', 'wa:91@c.us': 'id-4', 'C1:5.5#side-6.6': 'id-5' })
    assert.equal(s.conversation('dm')?.conversation.chat, DM)
    assert.equal(s.conversation('wa:91@c.us')?.conversation.connector, 'whatsapp')
    // A second import changes nothing that is already there.
    s.saveSessions({ ...s.sessions(), 'C1:5.5': 'id-new' })
    s.importThreads(old, DM, 60)
    assert.equal(s.sessions()['C1:5.5'], 'id-new')
  })
})
