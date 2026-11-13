import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
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

describe('the inbox: every message the hub hears, written before it is acknowledged', () => {
  test('a source id is taken once: a redelivery after a restart is a duplicate', () => {
    const path = `${process.env.TMPDIR ?? '/tmp'}/kage-inbox-${process.pid}-${Date.now()}.db`
    const a = openStore(path)
    assert.equal(a.take('slack:C1:5.5', 'slack', '{"ts":"5.5"}', 100), true)
    assert.equal(a.take('slack:C1:5.5', 'slack', '{"ts":"5.5"}', 101), false)
    a.close()
    assert.equal(openStore(path).take('slack:C1:5.5', 'slack', '{"ts":"5.5"}', 200), false)
  })
  test('a message taken but never handled comes back on the next start, once handled it does not', () => {
    const s = openStore(':memory:')
    s.take('slack:C1:1.1', 'slack', 'one', 100)
    s.take('github:abc', 'github', 'two', 110)
    s.take('slack:C1:2.2', 'slack', 'three', 120)
    s.handled('slack:C1:1.1')
    assert.deepEqual(s.unhandled(0), [{ source: 'github:abc', connector: 'github', payload: 'two', at: 110 }, { source: 'slack:C1:2.2', connector: 'slack', payload: 'three', at: 120 }])
  })
  test('a delivered message keeps its text until its turn ends, and a restart in between does not run it again', () => {
    const s = openStore(':memory:')
    s.take('slack:C1:1.1', 'slack', 'one', 100)
    assert.equal(s.delivered('slack:C1:1.1'), true)
    assert.equal(s.delivered('slack:C1:404'), false)
    assert.deepEqual(s.unhandled(0), [])
    assert.equal(s.has('slack:C1:1.1'), true)
  })
  test('a held message stays with its reset time, is never let go for its age, and replays after release', () => {
    const s = openStore(':memory:')
    s.take('slack:C1:1.1', 'slack', 'one', 100)
    s.take('slack:C1:2.2', 'slack', 'two', 90)
    s.delivered('slack:C1:1.1')
    assert.equal(s.hold('slack:C1:1.1', 5000), true)
    assert.equal(s.hold('slack:C1:2.2', 5000), true)
    assert.equal(s.hold('slack:C1:404', 5000), false)
    // A handled message has no text left to replay, so it cannot be held or taken as delivered.
    s.take('slack:C1:3.3', 'slack', 'three', 80)
    s.handled('slack:C1:3.3')
    assert.equal(s.hold('slack:C1:3.3', 5000), false)
    assert.equal(s.delivered('slack:C1:3.3'), false)
    assert.deepEqual(s.unhandled(1e9), [])
    assert.deepEqual(s.held(), [{ source: 'slack:C1:2.2', connector: 'slack', payload: 'two', at: 90, until: 5000 }, { source: 'slack:C1:1.1', connector: 'slack', payload: 'one', at: 100, until: 5000 }])
    s.release('slack:C1:1.1')
    assert.deepEqual(s.held().map(r => r.source), ['slack:C1:2.2'])
    assert.deepEqual(s.unhandled(0).map(r => r.source), ['slack:C1:1.1'])
    s.handled('slack:C1:2.2')
    assert.deepEqual(s.held(), [])
  })
  test('a store made before the pause columns existed gains them, and keeps its rows', () => {
    const path = `${process.env.TMPDIR ?? '/tmp'}/kage-inbox-old-${process.pid}-${Date.now()}.db`
    const old = new DatabaseSync(path)
    old.exec("create table inbox (source text primary key, connector text not null, at integer not null, payload text); insert into inbox values ('slack:C1:1.1', 'slack', 100, 'one')")
    old.close()
    const s = openStore(path)
    assert.equal(s.delivered('slack:C1:1.1'), true)
    assert.equal(s.hold('slack:C1:1.1', 5000), true)
    assert.deepEqual(s.held().map(r => r.payload), ['one'])
    s.close()
    assert.deepEqual(openStore(path).held().map(r => r.until), [5000])   // opening again changes nothing
  })
  test('a message too old to replay is marked handled instead, so it never comes back', () => {
    const s = openStore(':memory:')
    s.take('slack:C1:1.1', 'slack', 'old', 100)
    s.take('slack:C1:2.2', 'slack', 'new', 500)
    assert.deepEqual(s.unhandled(300).map(r => r.source), ['slack:C1:2.2'])
    assert.deepEqual(s.unhandled(0).map(r => r.source), ['slack:C1:2.2'])
  })
  test('a handled message keeps only its source id: other people\'s text does not stay in the store', () => {
    const path = `${process.env.TMPDIR ?? '/tmp'}/kage-inbox-text-${process.pid}-${Date.now()}.db`
    const s = openStore(path)
    s.take('slack:C1:1.1', 'slack', 'secret text', 100)
    s.handled('slack:C1:1.1')
    assert.equal(s.take('slack:C1:1.1', 'slack', 'secret text', 101), false)
    s.close()
    const raw = new DatabaseSync(path, { readOnly: true })
    assert.deepEqual({ ...raw.prepare('select count(*) n from inbox where payload is not null').get() }, { n: 0 })
  })
  test('an id recorded with no payload catches repeats and is never replayed (SQS holds the mail itself)', () => {
    const s = openStore(':memory:')
    assert.equal(s.has('mail:<a@x>'), false)
    assert.equal(s.take('mail:<a@x>', 'mail', null, 100), true)
    assert.equal(s.has('mail:<a@x>'), true)
    assert.equal(s.take('mail:<a@x>', 'mail', null, 101), false)
    assert.deepEqual(s.unhandled(0), [])
  })
  test('source ids older than the keep window are dropped', () => {
    const s = openStore(':memory:')
    s.take('a', 'slack', 'x', 100); s.handled('a')
    s.take('b', 'slack', 'y', 900); s.handled('b')
    s.prune(500)
    assert.equal(s.take('a', 'slack', 'x', 1000), true)
    assert.equal(s.take('b', 'slack', 'y', 1000), false)
  })
})

describe('saved state: what a connector keeps across a restart (AFK, GitHub and mail threads)', () => {
  const tmp = () => mkdtempSync(`${tmpdir()}/kage-state-`)
  test('a saved value reads back after a restart, and undefined removes it', () => {
    const path = `${tmp()}/kage.db`
    const a = openStore(path)
    assert.equal(a.load('afk'), undefined)
    a.save('afk', { until: 5, watch: { 'C1:5.5': 1 } })
    a.close()
    const b = openStore(path)
    assert.deepEqual(b.load('afk'), { until: 5, watch: { 'C1:5.5': 1 } })
    b.save('afk', undefined)
    assert.equal(b.load('afk'), undefined)
  })
  test('an old JSON file moves in once and is kept beside as .imported', () => {
    const dir = tmp()
    writeFileSync(`${dir}/github-threads.json`, '{"acme/app#12":"100.1"}')
    const s = openStore(':memory:')
    s.importState({ 'github-threads': `${dir}/github-threads.json` })
    assert.deepEqual(s.load('github-threads'), { 'acme/app#12': '100.1' })
    assert.equal(existsSync(`${dir}/github-threads.json`), false)
    assert.equal(readdirSync(dir).filter(f => f.startsWith('github-threads.json.imported-')).length, 1)
  })
  test('a row already saved wins over a file left by a crash, and the file is cleared', () => {
    const dir = tmp()
    const s = openStore(':memory:')
    s.save('afk', { until: 9 })
    writeFileSync(`${dir}/afk.json`, '{"until":1}')
    s.importState({ afk: `${dir}/afk.json` })
    assert.deepEqual(s.load('afk'), { until: 9 })
    assert.equal(existsSync(`${dir}/afk.json`), false)
  })
  test('a file that is not JSON is left where it is, and nothing is saved', () => {
    const dir = tmp()
    writeFileSync(`${dir}/mail-threads.json`, '{"half')
    const s = openStore(':memory:')
    s.importState({ 'mail-threads': `${dir}/mail-threads.json` })
    assert.equal(s.load('mail-threads'), undefined)
    assert.equal(existsSync(`${dir}/mail-threads.json`), true)
  })
})
