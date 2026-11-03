import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Delivery } from '../core/sessions.ts'
import type { Task } from './protocol.ts'
import { scheduler } from './scheduler.ts'
import { openStore } from './store.ts'

function setup(result: Delivery = 'sent') {
  const store = openStore(':memory:')
  store.seen('C1:5.5', { connector: 'slack', chat: 'C1', thread: '5.5', kind: 'channel' }, '#ops', 0)
  store.seen('C2:1.1', { connector: 'slack', chat: 'C2', thread: '1.1', kind: 'channel' }, '#two', 0)
  store.seen('mail:<r@x>', { connector: 'email', chat: '<r@x>', kind: 'mail' }, 'mail', 0)
  const sent: [string, Task][] = []
  const failed: Task[] = []
  const busy = new Set<string>()
  const blocked = new Set<string>()
  const owner = new Set<string>()
  let breakOn = ''
  const s = scheduler({
    store, failed: t => failed.push(t),
    deliver: (key, task) => { if (key === breakOn) throw new Error('boom'); sent.push([key, task]); return result },
    ready: key => blocked.has(key) ? 'blocked' : busy.has(key) ? 'busy' : 'ready',
    trusted: key => owner.has(key),
  })
  return { store, s, sent, failed, busy, blocked, owner, breakAt: (k: string) => { breakOn = k } }
}
const job = { id: 'j1', cron: '*/15 * * * *', prompt: 'check the queue', recurring: true }
const at = (s: string) => new Date(s).getTime()

test('a due schedule runs as a task in its own thread, with the trust it was set up with, once per run', () => {
  const t = setup()
  t.s.add('C1:5.5', job, new Date('2026-11-03T10:01:00').getTime())
  t.s.tick(new Date('2026-11-03T10:15:05').getTime())
  t.s.tick(new Date('2026-11-03T10:15:30').getTime())
  assert.equal(t.sent.length, 1)
  const [key, task] = t.sent[0]!
  assert.equal(key, 'C1:5.5')
  assert.equal(task.fromOwner, false)
  assert.deepEqual(task.meta, { channel: 'C1', thread_ts: '5.5', place: '#ops', permalink: '' })
  assert.equal(task.origin.ts, '')                       // no message to react on
  assert.match(task.content, /^Scheduled run of job j1 \(\*\/15 \* \* \* \*\)/)
  assert.match(task.content, /check the queue$/)
})
test('a run that cannot reach a session is reported, and a one-shot is gone after it runs', () => {
  const t = setup('failed')
  t.s.add('C1:5.5', { ...job, recurring: false, cron: '15 10 3 11 *' }, new Date('2026-11-03T10:01:00').getTime())
  t.s.tick(new Date('2026-11-03T10:15:05').getTime())
  assert.equal(t.failed.length, 1)
  assert.deepEqual(t.store.schedules(), [])
})
test('a schedule is refused for a bad cron, outside Slack, or past 50 per thread; a thread removes only its own', () => {
  const t = setup()
  assert.match(t.s.add('C1:5.5', { ...job, cron: 'nope' }, 0)!, /5 fields/)
  assert.match(t.s.add('mail:<r@x>', job, 0)!, /Slack/)
  for (let i = 0; i < 50; i++) assert.equal(t.s.add('C1:5.5', { ...job, id: `j${i}` }, 0), undefined)
  assert.match(t.s.add('C1:5.5', { ...job, id: 'jx' }, 0)!, /50/)
  t.s.remove('C2:1.1', 'j1')
  assert.equal(t.s.list('C1:5.5').length, 50)
  t.s.remove('C1:5.5', 'j1')
  assert.equal(t.s.list('C1:5.5').length, 49)
})

test('jobs moved out of the old panes keep their id and cron, do not rerun a minute the pane already ran, and skip what cannot run here', () => {
  const t = setup()
  const now = new Date('2026-11-03T16:52:30').getTime()
  const r = t.s.adopt([
    { ...job, fromOwner: true, id: '63c6a3d3', key: 'C1:5.5', cron: '7,22,37,52 13-20 3 11 *', created: at('2026-11-03T13:00:00') },
    { ...job, fromOwner: true, id: 'daily', key: 'C2:1.1', cron: '1 19 * * *', created: at('2026-11-01T09:00:00') },
    { ...job, fromOwner: true, id: 'aa', key: 'mail:<r@x>', created: 1 },
    { ...job, fromOwner: true, id: 'bb', key: 'C1:5.5', cron: 'bad', created: 1 },
  ], now)
  assert.deepEqual(r, { adopted: ['63c6a3d3', 'daily'], skipped: ['aa', 'bb'] })
  // A job pinned to a date keeps CronCreate's 7-day end; any other job runs until cancelled.
  assert.equal(t.store.schedules().find(s => s.id === '63c6a3d3')!.ends, at('2026-11-10T13:00:00'))
  assert.equal(t.store.schedules().find(s => s.id === 'daily')!.ends, undefined)
  t.s.tick(now + 20_000)
  assert.equal(t.sent.length, 0)                        // 16:52 already ran in the pane
  t.s.tick(new Date('2026-11-03T17:07:05').getTime())
  assert.equal(t.sent.length, 1)
})
test('a one-time job moved out of a pane still runs at its time', () => {
  const t = setup()
  t.s.adopt([{ ...job, fromOwner: true, id: 'once', key: 'C1:5.5', recurring: false, cron: '0 8 4 11 *', created: 1 }], new Date('2026-11-03T17:00:00').getTime())
  t.s.tick(new Date('2026-11-03T17:00:30').getTime())
  assert.equal(t.store.schedules().length, 1)
  t.s.tick(new Date('2026-11-04T08:00:10').getTime())
  assert.equal(t.sent.length, 1)
})

test('a run that finds its thread busy, held or waiting waits for the next tick instead of piling up', () => {
  const t = setup()
  t.s.add('C1:5.5', job, at('2026-11-03T10:01:00'))
  t.busy.add('C1:5.5')
  t.s.tick(at('2026-11-03T10:15:05'))
  t.s.tick(at('2026-11-03T10:15:25'))
  assert.equal(t.sent.length, 0)
  t.busy.delete('C1:5.5')
  t.s.tick(at('2026-11-03T10:17:00'))   // the 10:15 run, once the thread is free
  t.s.tick(at('2026-11-03T10:17:20'))
  assert.equal(t.sent.length, 1)
})
test('a one-time run waits for a busy thread and is not lost', () => {
  const t = setup()
  t.s.add('C1:5.5', { ...job, recurring: false, cron: '15 10 3 11 *' }, at('2026-11-03T10:01:00'))
  t.busy.add('C1:5.5')
  t.s.tick(at('2026-11-03T10:15:05'))
  assert.equal(t.store.schedules().length, 1)
  t.busy.delete('C1:5.5')
  t.s.tick(at('2026-11-03T11:40:00'))   // long after: a one-time job still runs
  assert.equal(t.sent.length, 1)
  assert.deepEqual(t.store.schedules(), [])
})
test('owner trust comes from the hub, never from the session', () => {
  const t = setup()
  t.s.add('C1:5.5', { ...job, fromOwner: true } as typeof job, at('2026-11-03T10:01:00'))
  assert.equal(t.store.schedules()[0]!.fromOwner, false)
  t.owner.add('C2:1.1')
  t.s.add('C2:1.1', { ...job, id: 'j2' }, at('2026-11-03T10:01:00'))
  assert.equal(t.store.schedules().find(s => s.id === 'j2')!.fromOwner, true)
})
test('a cron that never runs is refused, a leap day is not, and a dated cron set up here runs every year', () => {
  const t = setup()
  assert.match(t.s.add('C1:5.5', { ...job, cron: '0 0 30 2 *' }, at('2026-11-03T10:01:00'))!, /never runs/)
  assert.equal(t.s.add('C1:5.5', { ...job, id: 'leap', cron: '0 9 29 2 *' }, at('2026-11-03T10:01:00')), undefined)
  t.s.add('C1:5.5', { ...job, cron: '52 20 3 11 *' }, at('2026-11-03T10:01:00'))
  t.s.tick(at('2026-11-03T20:52:05'))
  assert.equal(t.sent.length, 1)
  assert.equal(t.store.schedules().length, 2)
})
test('a run that keeps finding its thread busy goes in after 5 minutes; one held or queued keeps waiting', () => {
  const t = setup()
  t.s.add('C1:5.5', job, at('2026-11-03T10:01:00'))
  t.s.add('C2:1.1', { ...job, id: 'j2' }, at('2026-11-03T10:01:00'))
  t.busy.add('C1:5.5')
  t.blocked.add('C2:1.1')
  t.s.tick(at('2026-11-03T10:15:05'))
  t.s.tick(at('2026-11-03T10:19:55'))
  assert.equal(t.sent.length, 0)
  t.s.tick(at('2026-11-03T10:20:10'))   // runs behind the current turn
  t.s.tick(at('2026-11-03T10:20:30'))
  assert.deepEqual(t.sent.map(([k]) => k), ['C1:5.5'])
})
test('one run failing does not cost the others in the same tick', () => {
  const t = setup()
  t.s.add('C1:5.5', job, at('2026-11-03T10:01:00'))
  t.s.add('C2:1.1', { ...job, id: 'j2' }, at('2026-11-03T10:01:00'))
  t.breakAt('C1:5.5')
  t.s.tick(at('2026-11-03T10:15:05'))
  assert.deepEqual(t.sent.map(([k]) => k), ['C2:1.1'])
})
