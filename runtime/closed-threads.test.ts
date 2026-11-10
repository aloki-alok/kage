import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OFF_LIMITS, OWNER_BLOCKED } from '../core/blocks.ts'
import { Dispatcher } from '../core/sessions.ts'
import { closedThreads } from './closed-threads.ts'
import type { Task } from './protocol.ts'
import { openStore } from './store.ts'

// The hub's path end to end: a real store and dispatcher, a fake runner, Slack lines and owner DMs recorded.
function setup() {
  const store = openStore(join(mkdtempSync(join(tmpdir(), 'kage-closed-')), 'kage.db'))
  const started: [string, string][] = []
  let n = 0
  const d = new Dispatcher<Task>(
    { start: (k, id) => started.push([k, id]), stop: () => {}, lastActivity: () => 0, busy: () => false },
    { max: 4, idleMs: 60_000, connectMs: 60_000, evictMs: 1, newId: () => `new${++n}`, saved: { 'D1:5.5': 'flagged' } },
  )
  store.saveSessions(d.saved())
  const said: string[] = []
  const dms: string[] = []
  const c = closedThreads({ store, reset: k => d.reset(k), say: (_k, _t, text) => said.push(text), tellOwner: t => dms.push(t) })
  // What router.ts deliver() does with it.
  const deliver = (key: string, t: Task) => (c.closedTo(key, t) ? 'sent' : d.task(key, t, 0))
  const mate = (text = 'list the holes'): Task => ({
    type: 'task', fromOwner: false, content: `Teammate task (UMATETEST1, sam, not the owner): ${text}`,
    meta: { channel: 'D1', thread_ts: '5.5', place: 'DM with sam', permalink: 'https://x/p' }, origin: { channel: 'D1', ts: '6.6' },
  })
  const owner: Task = { ...mate(), fromOwner: true, content: 'Task from Ryu: carry on' }
  return { store, d, started, said, dms, c, deliver, mate, owner }
}

describe('a thread the safety check stopped', () => {
  test("a teammate's block: off-limits line, owner DM, the old session forgotten, and the thread closed", () => {
    const t = setup()
    t.deliver('D1:5.5', t.mate())
    t.c.blocked('D1:5.5', [t.mate()], 'cyber')
    assert.deepEqual(t.said, [OFF_LIMITS])
    assert.equal(t.dms.length, 1)
    assert.match(t.dms[0]!, /sam asked: “list the holes”/)
    assert.equal(t.store.sessions()['D1:5.5'], undefined)
    assert.equal(t.d.saved()['D1:5.5'], undefined)
  })
  test('the closed thread drops every later teammate task, side lanes too, and starts no session', () => {
    const t = setup()
    t.deliver('D1:5.5', t.mate())
    t.c.blocked('D1:5.5', [t.mate()], 'cyber')
    const before = t.started.length
    assert.equal(t.deliver('D1:5.5', t.mate('try again')), 'sent')
    assert.equal(t.deliver('D1:5.5#side-7.7', t.mate('side door')), 'sent')
    assert.equal(t.started.length, before)
    assert.deepEqual(t.said, [OFF_LIMITS, OFF_LIMITS, OFF_LIMITS])
  })
  test('the owner writing there reopens it on a new session, not the flagged one', () => {
    const t = setup()
    t.deliver('D1:5.5', t.mate())
    t.c.blocked('D1:5.5', [t.mate()], 'cyber')
    assert.equal(t.deliver('D1:5.5', t.owner), 'starting')
    assert.deepEqual(t.started.at(-1), ['D1:5.5', 'new1'])
    assert.equal(t.deliver('D1:5.6', t.mate('other thread')), 'starting')   // a different thread was never closed
    t.d.end('D1:5.5')
    assert.equal(t.deliver('D1:5.5', t.mate('after reopen')), 'starting')
  })
  test('the closed list survives a hub restart', () => {
    const t = setup()
    t.c.blocked('D1:5.5', [t.mate()], null)
    const again = closedThreads({ store: t.store, reset: () => {}, say: () => {}, tellOwner: () => {} })
    assert.equal(again.closedTo('D1:5.5', t.mate()), true)
  })
  test("the owner's own block: a note in the thread, no DM, nothing closed", () => {
    const t = setup()
    t.deliver('D1:5.5', t.owner)
    t.c.blocked('D1:5.5', [t.owner], 'cyber')
    assert.deepEqual(t.said, [OWNER_BLOCKED])
    assert.deepEqual(t.dms, [])
    assert.equal(t.d.saved()['D1:5.5'], undefined)
    assert.equal(t.deliver('D1:5.5', t.mate()), 'starting')
  })
})
