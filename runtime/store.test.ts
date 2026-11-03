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
    const old = { 'C1:5.5': 'id-1', dm: 'id-2', 'mail:<r@x>': 'id-3', 'C1:5.5#side-6.6': 'id-5', junk: 'id-6' }
    const r = s.importThreads(old, DM, 50)
    assert.deepEqual(r, { imported: 4, skipped: ['junk'] })
    assert.deepEqual(s.sessions(), { 'C1:5.5': 'id-1', dm: 'id-2', 'mail:<r@x>': 'id-3', 'C1:5.5#side-6.6': 'id-5' })
    assert.equal(s.conversation('dm')?.conversation.chat, DM)
    assert.equal(s.conversation('mail:<r@x>')?.conversation.connector, 'email')
    // A second import changes nothing that is already there.
    s.saveSessions({ ...s.sessions(), 'C1:5.5': 'id-new' })
    s.importThreads(old, DM, 60)
    assert.equal(s.sessions()['C1:5.5'], 'id-new')
  })
  test('schedules are kept per thread, marked when they fire, and removed only from their own thread', () => {
    const s = openStore(':memory:')
    const job = { id: 'j1', key: 'C1:5.5', cron: '*/15 * * * *', prompt: 'check', recurring: true, fromOwner: false, created: 10, lastFired: 0 }
    s.addSchedule(job)
    s.addSchedule({ ...job, id: 'j2', key: 'C2:1.1' })
    s.fired('j1', 99)
    assert.deepEqual(s.schedules().find(x => x.id === 'j1'), { ...job, lastFired: 99 })
    assert.equal(s.removeSchedule('j2', 'C1:5.5'), false)   // another thread's job stays
    assert.equal(s.removeSchedule('j2', 'C2:1.1'), true)
    assert.deepEqual(s.schedules().map(x => x.id), ['j1'])
  })
})

test('a thread keeps its owner trust across a restart', () => {
  const s = openStore(':memory:')
  assert.equal(s.trust('C1:5.5'), undefined)
  s.setTrust('C1:5.5', true)
  assert.equal(s.trust('C1:5.5'), true)
  s.setTrust('C1:5.5', false)
  assert.equal(s.trust('C1:5.5'), false)
  s.noteTask('C1:5.5', true, false)
  assert.equal(s.trust('C1:5.5'), false)                // one teammate task is enough to lose it
  s.noteTask('new', true, false)
  assert.equal(s.trust('new'), true)
  s.noteTask('old', true, true)
  assert.equal(s.trust('old'), false)                   // a session from before trust was recorded
})

test('imported threads keep their key as the name until a lookup names them', () => {
  const s = openStore(':memory:')
  s.importThreads({ 'C1:5.5': 'id1' }, 'DBOT00001', 0)
  s.seen('C2:1.1', { connector: 'slack', chat: 'C2', thread: '1.1', kind: 'channel' }, '#two', 0)
  assert.deepEqual(s.unnamed(), [{ key: 'C1:5.5', chat: 'C1' }])
  s.name('C1:5.5', '#ops')
  assert.deepEqual(s.unnamed(), [])
  assert.equal(s.conversation('C1:5.5')!.place, '#ops')
})
