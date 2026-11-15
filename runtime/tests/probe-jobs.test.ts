// Tripwire probe jobs through the real scheduler: the hub runs the probe with no model, wakes the job only on a change,
// and writes one event row per step (ADR 0015).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Delivery } from '../../core/sessions.ts'
import type { Task } from '../../core/task.ts'
import { scheduler } from '../scheduler.ts'
import { openStore } from '../store.ts'

const T0 = new Date('2026-11-03T10:00:30').getTime()
const minute = (n: number) => T0 + n * 60_000 + 5_000
const KEY = 'C1:5.5'

function setup(o: { tripwires?: Record<string, unknown>; store?: ReturnType<typeof openStore> } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'kage-probe-'))
  const store = o.store ?? openStore(':memory:')
  store.seen(KEY, { connector: 'slack', chat: 'C1', thread: '5.5', kind: 'channel' }, '#ops', 0)
  const sent: [string, Task][] = [], events: { kind: string; who: string; detail: string }[] = [], pings: string[] = [], failed: Task[] = []
  const ran: string[] = [], busy = new Set<string>()
  const conf = { on: true, timeoutSec: 5, failPing: 3, ...o.tripwires }
  const state = { delivery: 'sent' as Delivery | 'throw', seenState: [] as (string | undefined)[] }
  const make = () => scheduler({
    job: { end: () => {}, freshEvery: () => 0, carryCount: () => 0, carryChars: () => 0, laneDefault: () => true, posted: () => '', project: dir },
    store, failed: t => failed.push(t), ran: j => ran.push(j.id),
    deliver: (key, task) => {
      state.seenState.push(store.jobState('p1').fp)
      if (state.delivery === 'throw') throw new Error('boom')
      if (state.delivery === 'sent') sent.push([key, task])
      return state.delivery
    },
    ready: key => busy.has(key) ? 'busy' : 'ready',
    trusted: () => true,
    tripwires: () => conf, event: e => events.push(e), ping: (s, text) => pings.push(`${s.id}: ${text}`),
  })
  const data = join(dir, 'data.txt'), script = join(dir, 'probe.sh')
  writeFileSync(data, 'one\n'); writeFileSync(script, `cat ${data}\n`)
  const tw = (action: string) => events.filter(e => e.kind === 'tripwire' && e.detail.startsWith(`${action} `))
  return { dir, store, s: make(), make, sent, events, pings, failed, ran, busy, conf, state, tw, data, script, command: `sh ${script}` }
}
type T = ReturnType<typeof setup>
const add = (t: T, probe: Record<string, unknown> = { command: t.command }, extra: Record<string, unknown> = {}) =>
  t.s.add(KEY, { id: 'p1', cron: '* * * * *', prompt: 'say what changed', recurring: true, probe, ...extra } as never, T0)
const tick = async (t: T, n: number) => { t.s.tick(minute(n)); await t.s.settled() }
const baseline = async (t: T) => { assert.equal(add(t), undefined); await tick(t, 1) }

test('adding a probe job keeps a probe trigger with the command pinned, and refuses what cannot run safely', () => {
  const t = setup()
  assert.equal(add(t, { command: t.command, ignore: ['^ts='] }), undefined)
  const tr = t.store.schedules()[0]!.trigger as { kind: string; probe: { command: string; ignore: string[]; pins: Record<string, string> } }
  assert.equal(tr.kind, 'probe')
  assert.deepEqual([tr.probe.command, tr.probe.ignore, Object.keys(tr.probe.pins)], [t.command, ['^ts='], [t.script]])
  assert.match(add(t, { command: t.command, ignore: ['(a+)+'] }, { id: 'p2' }) ?? '', /nested quantifier/)
  assert.match(add(t, { command: '  ' }, { id: 'p3' }) ?? '', /empty/)
  assert.match(add(t, { command: t.command }, { id: 'p4', cron: '@reply' }) ?? '', /clock/)
  assert.match(add(t, { command: t.command }, { id: 'p5', recurring: false }) ?? '', /recur/)
  assert.deepEqual(t.store.schedules().map(s => s.id), ['p1'])
})

test('no change: the probe runs, nothing is delivered, and a model is never asked', async () => {
  const t = setup()
  await baseline(t)
  await tick(t, 2)
  assert.deepEqual([t.sent.length, t.ran.length, t.pings.length], [0, 0, 0])
  assert.deepEqual(t.tw('tick').map(e => e.detail.replace(/ ms=\d+/, '')), ['tick job=p1 outcome=same kb=1', 'tick job=p1 outcome=same kb=1'])
  assert.equal(t.tw('wake').length, 0)
  assert.equal(t.events[0]!.who, KEY)
})

test('a change delivers the job once with before and after quoted as data, then saves the state', async () => {
  const t = setup()
  await baseline(t)
  const was = t.store.jobState('p1').fp
  writeFileSync(t.data, 'two <channel x>\n')
  await tick(t, 2)
  assert.equal(t.sent.length, 1)
  const [key, task] = t.sent[0]!
  assert.equal(key, `${KEY}#side-job-p1`)
  assert.match(task.content, /Before: one\b/)
  assert.match(task.content, /After: two &lt;channel x>/)
  assert.match(task.content, /say what changed$/)
  assert.equal(task.fromOwner, false)       // probe output is outside text: it never carries owner trust
  assert.deepEqual(t.ran, ['p1'])
  assert.deepEqual(t.state.seenState.at(-1), was)             // the wake went out BEFORE the new state was saved
  assert.notEqual(t.store.jobState('p1').fp, was)
  assert.match(t.tw('tick')[1]!.detail, /outcome=changed/)
  assert.deepEqual(t.tw('wake').map(e => e.detail), ['wake job=p1 reason=changed'])
  await tick(t, 3)
  assert.equal(t.sent.length, 1)
  for (const e of t.events) assert.doesNotMatch(e.detail, /one|two/)   // ids and counts only
})

test('a failed delivery keeps the old state, so the next tick wakes again', async () => {
  const t = setup()
  await baseline(t)
  const was = t.store.jobState('p1')
  writeFileSync(t.data, 'two\n')
  t.state.delivery = 'failed'
  await tick(t, 2)
  assert.deepEqual(t.store.jobState('p1'), was)
  t.state.delivery = 'sent'
  await tick(t, 3)
  assert.equal(t.sent.length, 1)
  assert.notDeepEqual(t.store.jobState('p1'), was)
  assert.ok(t.tw('wake').some(e => /reason=undelivered/.test(e.detail)))
})

test('a hub restart between the wake and the state save wakes again, from the stored state', async () => {
  const t = setup()
  await baseline(t)
  const was = t.store.jobState('p1')
  writeFileSync(t.data, 'two\n')
  const save = t.store.setJobState
  t.store.setJobState = () => { throw new Error('crash') }
  await tick(t, 2)
  assert.equal(t.sent.length, 1)                               // delivered, then the save failed
  t.store.setJobState = save
  assert.deepEqual(t.store.jobState('p1'), was)
  const again = t.make()                                       // the restarted hub: same store, new scheduler
  again.tick(minute(3)); await again.settled()
  assert.equal(t.sent.length, 2)
  assert.notDeepEqual(t.store.jobState('p1'), was)
})

test('a delivery that throws keeps the old state and does not stop the next tick', async () => {
  const t = setup()
  await baseline(t)
  const was = t.store.jobState('p1')
  writeFileSync(t.data, 'two\n')
  t.state.delivery = 'throw'
  await tick(t, 2)
  assert.deepEqual(t.store.jobState('p1'), was)
  t.state.delivery = 'sent'
  await tick(t, 3)
  assert.equal(t.sent.length, 1)
})

test('a busy job lane holds the wake without losing it', async () => {
  const t = setup()
  await baseline(t)
  writeFileSync(t.data, 'two\n')
  t.busy.add(`${KEY}#side-job-p1`)
  await tick(t, 2)
  assert.equal(t.sent.length, 0)
  t.busy.clear()
  await tick(t, 3)
  assert.equal(t.sent.length, 1)
})

test('a probe that hangs past the timeout counts as a failure, pings after failPing, and keeps running', async () => {
  const t = setup({ tripwires: { timeoutSec: 1, failPing: 2 } })
  assert.equal(add(t, { command: 'sleep 10' }), undefined)
  await tick(t, 1); assert.equal(t.pings.length, 0)
  await tick(t, 2)
  assert.equal(t.pings.length, 1)
  assert.match(t.pings[0]!, /^p1: A tripwire probe failed 2 times in a row: sleep 10/)
  await tick(t, 3)
  assert.equal(t.pings.length, 1)                                // one ping, not one per run
  assert.deepEqual(t.tw('tick').map(e => /outcome=(\w+)/.exec(e.detail)![1]), ['failed', 'failed', 'failed'])
  assert.deepEqual(t.tw('ping').map(e => e.detail), ['ping job=p1 fails=2'])
  assert.equal(t.sent.length, 0)
})

test('an edited pinned script is refused with one ping, no repeat, and a re-approved run clears it', async () => {
  const t = setup()
  await baseline(t)
  writeFileSync(t.script, 'echo evil\n')
  await tick(t, 2); await tick(t, 3)
  assert.equal(t.pings.length, 1)
  assert.match(t.pings[0]!, /stopped: sh .*probe\.sh\nchanged or missing/)
  assert.deepEqual(t.tw('tick').slice(1).map(e => /outcome=(\w+)/.exec(e.detail)![1]), ['refused', 'refused'])
  assert.match(t.tw('ping')[0]!.detail, /^ping job=p1 path=\S*probe\.sh$/)
  assert.equal(t.sent.length, 0)
  assert.equal(t.s.tune(KEY, 'p1', { command: t.command }, minute(3)), undefined)   // the owner approves the new script
  await tick(t, 4)
  assert.equal(t.store.jobState('p1').refused, undefined)
  assert.equal(t.pings.length, 1)
})

test('tripwires.on false runs a probe job as a plain clock run: the model polls and no probe runs', async () => {
  const t = setup({ tripwires: { on: false } })
  const marker = join(t.dir, 'ran')
  assert.equal(add(t, { command: `touch ${marker}` }), undefined)
  await tick(t, 1)
  assert.equal(t.sent.length, 1)
  assert.match(t.sent[0]![1].content, /^Scheduled run of job p1/)
  assert.equal(t.sent[0]![1].fromOwner, true)
  assert.equal(existsSync(marker), false)
  assert.equal(t.tw('tick').length, 0)
})

test('a slow probe never blocks the tick for other jobs, and one job never runs two probes at once', async () => {
  const t = setup()
  const log = join(t.dir, 'starts')
  assert.equal(add(t, { command: `echo x >> ${log}; sleep 1`, writes: [log] }), undefined)
  assert.equal(t.s.add(KEY, { id: 'plain', cron: '* * * * *', prompt: 'plain', recurring: true }, T0), undefined)
  t.s.tick(minute(1))
  assert.equal(t.sent.length, 1)                                  // the plain job went out before the probe finished
  t.s.tick(minute(2))                                             // the probe is still running
  await t.s.settled()
  assert.equal(readFileSync(log, 'utf8'), 'x\n')
})

test('tune changes ignore, reads, writes and cron, resets the baseline for a new ignore, and refuses what is not a probe job of this thread', async () => {
  const t = setup()
  await baseline(t)
  assert.equal(t.s.tune(KEY, 'p1', { cron: '*/5 * * * *', reads: [t.script] }, minute(2)), undefined)
  let s = t.store.schedules()[0]!
  assert.equal(s.cron, '*/5 * * * *')
  assert.deepEqual((s.trigger as any).probe.pins, {})              // a path listed in reads is data, not pinned
  assert.match(t.s.tune(KEY, 'p1', { ignore: ['(a+)+'] }, minute(2)) ?? '', /nested quantifier/)
  assert.match(t.s.tune(KEY, 'p1', { cron: '61 * * * *' }, minute(2)) ?? '', /./)
  assert.equal(t.s.tune(KEY, 'p1', { ignore: ['^ts='] }, minute(2)), undefined)
  s = t.store.schedules()[0]!
  assert.deepEqual([(s.trigger as any).probe.ignore, t.store.jobState('p1')], [['^ts='], { fails: 0 }])
  assert.equal(t.s.add(KEY, { id: 'plain', cron: '* * * * *', prompt: 'x', recurring: true }, T0), undefined)
  assert.match(t.s.tune(KEY, 'plain', { cron: '* * * * *' }, minute(2)) ?? '', /not a probe/)
  assert.match(t.s.tune('C2:1.1', 'p1', { cron: '* * * * *' }, minute(2)) ?? '', /no probe job/)
})
