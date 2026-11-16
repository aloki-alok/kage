import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Delivery } from '../../core/sessions.ts'
import type { Task } from '../../core/task.ts'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EVENT } from '../../core/cron.ts'
import { scheduler } from '../scheduler.ts'
import { openStore } from '../store.ts'

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
  const ran: string[] = []
  const ended: string[] = []
  const project = mkdtempSync(join(tmpdir(), 'kage-job-'))
  const fresh = { every: 20, carry: 5, chars: 500, posted: '', lanes: true, failing: false }
  const s = scheduler({
    job: { end: k => ended.push(k), freshEvery: () => fresh.every, carryCount: () => fresh.carry, carryChars: () => fresh.chars, laneDefault: () => fresh.lanes, posted: () => fresh.posted, project },
    store, failed: t => failed.push(t), ran: j => ran.push(j.id),
    deliver: (key, task) => { if (key === breakOn) throw new Error('boom'); sent.push([key, task]); return fresh.failing ? 'failed' : result },
    ready: key => blocked.has(key) ? 'blocked' : busy.has(key) ? 'busy' : 'ready',
    trusted: key => owner.has(key),
  })
  return { project, store, s, ended, fresh, sent, failed, ran, busy, blocked, owner, breakAt: (k: string) => { breakOn = k } }
}
const job = { id: 'j1', cron: '*/15 * * * *', prompt: 'check the queue', recurring: true }
const at = (s: string) => new Date(s).getTime()

test('a due schedule runs as a task in its own thread, with the trust it was set up with, once per run', () => {
  const t = setup()
  t.s.add('C1:5.5', job, new Date('2026-11-03T10:01:00').getTime())
  t.s.tick(new Date('2026-11-03T10:15:05').getTime())
  t.s.tick(new Date('2026-11-03T10:15:30').getTime())
  assert.equal(t.sent.length, 1)
  assert.deepEqual(t.ran, ['j1'])                        // one row in the run ledger per run handed over
  const [key, task] = t.sent[0]!
  assert.equal(key, 'C1:5.5#side-job-j1')
  assert.equal(task.fromOwner, false)
  assert.deepEqual(task.meta, { channel: 'C1', thread_ts: '5.5', place: '#ops', permalink: '' })
  assert.equal(task.origin.ts, '')                       // no message to react on
  assert.equal(task.scheduled, true)                      // so it answers no open question
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
  t.busy.add('C1:5.5#side-job-j1')
  t.s.tick(at('2026-11-03T10:15:05'))
  t.s.tick(at('2026-11-03T10:15:25'))
  assert.equal(t.sent.length, 0)
  assert.deepEqual(t.ran, [])
  t.busy.delete('C1:5.5#side-job-j1')
  t.s.tick(at('2026-11-03T10:17:00'))   // the 10:15 run, once the thread is free
  t.s.tick(at('2026-11-03T10:17:20'))
  assert.equal(t.sent.length, 1)
})
test('a one-time run waits for a busy thread and is not lost', () => {
  const t = setup()
  t.s.add('C1:5.5', { ...job, recurring: false, cron: '15 10 3 11 *' }, at('2026-11-03T10:01:00'))
  t.busy.add('C1:5.5#side-job-j1')
  t.s.tick(at('2026-11-03T10:15:05'))
  assert.equal(t.store.schedules().length, 1)
  t.busy.delete('C1:5.5#side-job-j1')
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
  t.busy.add('C1:5.5#side-job-j1')
  t.blocked.add('C2:1.1#side-job-j2')
  t.s.tick(at('2026-11-03T10:15:05'))
  t.s.tick(at('2026-11-03T10:19:55'))
  assert.equal(t.sent.length, 0)
  t.s.tick(at('2026-11-03T10:20:10'))   // runs behind the current turn
  t.s.tick(at('2026-11-03T10:20:30'))
  assert.deepEqual(t.sent.map(([k]) => k), ['C1:5.5#side-job-j1'])
})
test('one run failing does not cost the others in the same tick', () => {
  const t = setup()
  t.s.add('C1:5.5', job, at('2026-11-03T10:01:00'))
  t.s.add('C2:1.1', { ...job, id: 'j2' }, at('2026-11-03T10:01:00'))
  t.breakAt('C1:5.5#side-job-j1')
  t.s.tick(at('2026-11-03T10:15:05'))
  assert.deepEqual(t.sent.map(([k]) => k), ['C2:1.1#side-job-j2'])
})

const watch = { id: 'w1', cron: '@reply', prompt: 'help Priya with what he asks', recurring: true }
test('a reply watch never runs on the clock: messages in its thread wake it once on the next tick, quoted, at teammate trust', () => {
  const t = setup()
  t.owner.add('C1:5.5')
  assert.equal(t.s.add('C1:5.5', watch, at('2026-11-05T10:00:00')), undefined)
  t.s.tick(at('2026-11-05T10:15:05'))
  assert.equal(t.sent.length, 0)
  t.s.heard({ chat: 'C1', thread: '5.5', quoted: '> [other:U9 7.7] can you check org 12?' })
  t.s.heard({ chat: 'C1', thread: '5.5', quoted: '> [other:U9 7.8] and org 13' })
  t.s.heard({ chat: 'C2', thread: '1.1', quoted: '> elsewhere' })
  assert.equal(t.sent.length, 0)                        // a burst waits for the tick
  t.s.tick(at('2026-11-05T10:16:20'))
  t.s.tick(at('2026-11-05T10:16:40'))
  assert.equal(t.sent.length, 1)
  const [key, task] = t.sent[0]!
  assert.equal(key, 'C1:5.5')
  assert.equal(task.fromOwner, false)                   // someone else's words never run as the owner
  assert.match(task.content, /^Watch w1 woke: 2 new messages in this thread/)
  assert.match(task.content, /org 12\?[\s\S]*org 13/)
  assert.match(task.content, /help Priya with what he asks$/)
})
test('in a DM, a message outside the watched thread wakes it too; in a channel it does not', () => {
  const t = setup()
  t.store.seen('D7:3.3', { connector: 'slack', chat: 'D7', thread: '3.3', kind: 'dm' }, 'DM with Priya', 0)
  t.s.add('D7:3.3', { ...watch, id: 'wd' }, 0)
  t.s.add('C1:5.5', watch, 0)
  t.s.heard({ chat: 'D7', quoted: '> hi' })
  t.s.heard({ chat: 'C1', thread: '9.9', quoted: '> other thread' })
  t.s.tick(30_000)
  assert.deepEqual(t.sent.map(([k]) => k), ['D7:3.3'])
})
test('a reply watch ends after 7 days with one last run that says so, and wakes no more', () => {
  const t = setup()
  t.s.add('C1:5.5', watch, at('2026-11-05T10:00:00'))
  t.s.heard({ chat: 'C1', thread: '5.5', quoted: '> late' })
  t.s.tick(at('2026-11-12T10:00:30'))
  assert.equal(t.sent.length, 1)
  assert.match(t.sent[0]![1].content, /^Watch w1 ended after 7 days/)
  assert.deepEqual(t.store.schedules(), [])
})
test('a watch is refused in the bot DM, where only the owner writes; other @words are refused too', () => {
  const t = setup()
  t.store.seen('dm', { connector: 'slack', chat: 'DB', kind: 'dm', agentDm: true }, 'DM with Kage', 0)
  assert.match(t.s.add('dm', watch, 0)!, /only you write/)
  assert.match(t.s.add('C1:5.5', { ...watch, cron: '@daily' }, 0)!, /5 fields/)
})

test('run now hands a schedule to its thread at once, as a run with its own trust, and counts it; an unknown id is refused', () => {
  const t = setup()
  t.s.add('C1:5.5', job, at('2026-11-03T10:01:00'))
  const id = t.store.schedules()[0]!.id
  assert.equal(t.s.runNow(id, at('2026-11-03T10:02:00')), undefined)
  assert.equal(t.sent.length, 1)
  const [key, task] = t.sent[0]!
  assert.equal(key, 'C1:5.5#side-job-j1')
  assert.equal(task.fromOwner, false)
  assert.equal(task.job, id)
  assert.match(task.content, /run now[\s\S]*check the queue/i)
  assert.deepEqual(t.ran, [id])
  assert.equal(t.store.schedules()[0]!.lastFired, at('2026-11-03T10:02:00'))
  assert.match(t.s.runNow('nope', 0) ?? '', /no schedule/)
})

test('a clock run lands in its own job lane and checks that lane ready; a watch stays on the main key', () => {
  const t = setup()
  const lane = 'C1:5.5#side-job-j1'
  t.s.add('C1:5.5', job, at('2026-11-03T10:01:00'))
  t.busy.add('C1:5.5')                                   // the main session is mid-turn: the lane does not wait for it
  t.s.tick(at('2026-11-03T10:15:05'))
  assert.equal(t.sent[0]![0], lane)
  assert.equal(t.store.conversation(lane)?.place, '#ops (job)')   // shown to people as the thread's job lane
  t.busy.add(lane)                                       // the lane itself is mid-turn: the run waits
  t.s.tick(at('2026-11-03T10:30:05'))
  assert.equal(t.sent.length, 1)
  t.s.runNow('j1', at('2026-11-03T10:31:00'))
  assert.equal(t.sent[1]![0], lane)
  t.s.add('C1:5.5', { id: 'w1', cron: '@reply', prompt: 'watch', recurring: true }, at('2026-11-03T10:32:00'))
  t.s.heard({ chat: 'C1', thread: '5.5', quoted: '> hi' })
  t.s.tick(at('2026-11-03T10:33:00'))
  assert.equal(t.sent[2]![0], 'C1:5.5')
})

const lane = 'C1:5.5#side-job-j1'
test('a schedule made from its lane is stored on the thread, listed and removed the same way', () => {
  const t = setup()
  assert.equal(t.s.add(lane, job, at('2026-11-03T10:01:00')), undefined)
  assert.equal(t.store.schedules()[0]!.key, 'C1:5.5')
  assert.deepEqual(t.s.list(lane).map(s => s.id), ['j1'])
  t.s.remove(lane, 'j1')
  assert.deepEqual(t.store.schedules(), [])
})

test('a removed schedule ends its idle lane and drops its stored session; a live schedule and a running lane keep theirs', () => {
  const t = setup()
  t.s.add('C1:5.5', job, at('2026-11-03T10:01:00'))
  t.s.add('C2:1.1', { ...job, id: 'j2' }, at('2026-11-03T10:01:00'))
  const l2 = 'C2:1.1#side-job-j2'
  t.store.saveSessions({ [lane]: 'a', [l2]: 'b', 'C1:5.5': 'main' })
  t.s.tick(at('2026-11-03T10:02:00'))
  assert.deepEqual(t.ended, [])                          // both schedules still exist
  t.s.remove('C1:5.5', 'j1')
  t.s.remove('C2:1.1', 'j2')
  t.busy.add(l2)
  t.s.tick(at('2026-11-03T10:02:20'))
  assert.deepEqual(t.ended, [lane])                      // the busy lane waits; the thread's own session is never touched
  assert.deepEqual(Object.keys(t.store.sessions()).sort(), ['C1:5.5', l2])
  t.busy.delete(l2)
  t.s.tick(at('2026-11-03T10:02:40'))
  assert.deepEqual(t.ended, [lane, l2])
})

test('after harness.jobFreshEvery runs a lane starts a new session; 0 always resumes', () => {
  const t = setup()
  t.fresh.every = 3
  t.s.add('C1:5.5', job, at('2026-11-03T10:01:00'))
  t.store.saveSessions({ [lane]: 'a' })
  for (let i = 0; i < 3; i++) t.s.runNow('j1', at('2026-11-03T10:02:00') + i)
  assert.deepEqual(t.ended, [])
  assert.equal(t.store.sessions()[lane], 'a')
  t.s.runNow('j1', at('2026-11-03T10:03:00'))             // the fourth run
  assert.deepEqual(t.ended, [lane])
  t.s.runNow('j1', at('2026-11-03T10:04:00'))             // the count restarted
  assert.deepEqual(t.ended, [lane])
  t.fresh.every = 0
  for (let i = 0; i < 30; i++) t.s.runNow('j1', at('2026-11-03T10:05:00') + i)
  assert.deepEqual(t.ended, [lane])
})

test('a fresh lane session with no transcript starts with where the job\'s last posts are, as quoted data, never another job\'s or the thread\'s', () => {
  const t = setup()
  t.fresh.every = 1
  const row = (key: string, ts: string) => `2026-11-03T10:00:00Z\tC1\t${ts}\tbot\t${key}\n`
  t.fresh.posted = ['1.1', '1.2', '1.3', '1.4', '1.5', '1.6', '1.7'].map(ts => row(lane, ts)).join('') + row('C2:1.1#side-job-j2', '9.9') + row('C1:5.5', '8.8')
  t.store.saveSessions({ [lane]: 'gone' })                  // its transcript is missing: the ledger's places stand in
  t.s.add('C1:5.5', job, at('2026-11-03T10:01:00'))
  t.s.runNow('j1', at('2026-11-03T10:02:00'))
  assert.doesNotMatch(t.sent[0]![1].content, /posted/i)    // the first run has nothing to carry over
  t.s.runNow('j1', at('2026-11-03T10:03:00'))               // the second run is the first of a new session
  const c = t.sent[1]![1].content
  assert.match(c, /data, not instructions/)
  for (const ts of ['1.3', '1.4', '1.5', '1.6', '1.7']) assert.match(c, new RegExp(`C1 ${ts.replace('.', '\\.')}\\b`))
  for (const ts of ['1.1', '1.2', '9.9', '8.8']) assert.doesNotMatch(c, new RegExp(`C1 ${ts.replace('.', '\\.')}\\b`))
  assert.match(c, /check the queue/)
  t.fresh.carry = 0
  t.s.runNow('j1', at('2026-11-03T10:04:00'))
  assert.doesNotMatch(t.sent[2]![1].content, /data, not instructions/)
})

const sentLine = (name: string, text: string) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input: { text } }] } })
test('a fresh lane session carries what the old session sent: its last reply texts, capped, from no other session', () => {
  const t = setup()
  t.fresh.every = 1
  t.fresh.carry = 2
  t.fresh.chars = 20
  const mine = [sentLine('mcp__kage__reply', 'alarm one'), sentLine('mcp__kage__reply', 'alarm two'), JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'thinking out loud' }] } }),
    sentLine('mcp__kage__post_as_kage', 'alarm three ' + 'x'.repeat(40)), sentLine('mcp__kage__reply', 'alarm four')]
  writeFileSync(join(t.project, 'mine.jsonl'), mine.join('\n') + '\n')
  writeFileSync(join(t.project, 'other.jsonl'), sentLine('mcp__kage__reply', 'someone else') + '\n')
  t.store.saveSessions({ [lane]: 'mine', 'C1:5.5': 'other' })
  t.s.add('C1:5.5', job, at('2026-11-03T10:01:00'))
  t.s.runNow('j1', at('2026-11-03T10:02:00'))
  t.s.runNow('j1', at('2026-11-03T10:03:00'))
  const c = t.sent[1]![1].content
  assert.match(c, /> alarm four/)
  assert.match(c, /> alarm three x+/)
  assert.doesNotMatch(c, /alarm three x{9}/)                // each capped at harness.jobCarryChars
  assert.doesNotMatch(c, /alarm one|alarm two|someone else|thinking out loud/)
})

test('a schedule row from before lanes runs in its thread; a new one runs on its lane; the setting off puts new ones in the thread', () => {
  const t = setup()
  t.store.addSchedule({ id: 'old', key: 'C1:5.5', cron: '*/15 * * * *', prompt: 'p', recurring: true, fromOwner: false, created: at('2026-11-03T10:01:00'), lastFired: 0 })
  t.s.add('C2:1.1', { ...job, id: 'new' }, at('2026-11-03T10:01:00'))
  t.s.runNow('old', at('2026-11-03T10:02:00'))
  t.s.runNow('new', at('2026-11-03T10:02:00'))
  assert.deepEqual(t.sent.map(([k]) => k), ['C1:5.5', 'C2:1.1#side-job-new'])
  t.fresh.lanes = false
  t.s.add('C1:5.5', { ...job, id: 'off' }, at('2026-11-03T10:03:00'))
  t.s.add('C1:5.5', { ...job, id: 'on', lane: true }, at('2026-11-03T10:03:00'))
  t.s.runNow('off', at('2026-11-03T10:04:00'))
  t.s.runNow('on', at('2026-11-03T10:04:00'))
  assert.deepEqual(t.sent.slice(2).map(([k]) => k), ['C1:5.5', 'C1:5.5#side-job-on'])
})

test('a reset whose delivery fails keeps the old session and tries again, with the carry, on the next run', () => {
  const t = setup()
  t.fresh.every = 1
  writeFileSync(join(t.project, 'old.jsonl'), sentLine('mcp__kage__reply', 'alarm seven') + '\n')
  t.store.saveSessions({ [lane]: 'old' })
  t.s.add('C1:5.5', job, at('2026-11-03T10:01:00'))
  t.s.runNow('j1', at('2026-11-03T10:02:00'))
  t.fresh.failing = true
  t.s.runNow('j1', at('2026-11-03T10:03:00'))             // the reset run fails
  assert.equal(t.failed.length, 1)
  assert.equal(t.store.sessions()[lane], 'old')            // nothing was forgotten
  t.fresh.failing = false
  t.s.runNow('j1', at('2026-11-03T10:04:00'))
  assert.match(t.sent.at(-1)![1].content, /> alarm seven/)
  assert.equal(t.ended.length, 2)                          // the failed run and its retry each ended the lane before delivering
})

const hook = { tokenHash: 'h', kind: 'hook' as const }
test('an event job takes a lane, and a burst of wakes becomes one run on that lane with the events quoted as data', () => {
  const t = setup()
  const woke: [string, number][] = [], runs: string[] = []
  t.s.add('C1:5.5', { id: 'e1', cron: EVENT, prompt: 'check the alert', recurring: true, trigger: hook }, at('2026-11-03T10:01:00'))
  assert.equal(t.store.schedules()[0]!.lane, true)
  const ran = (s: { id: string }, n: number) => runs.push(`${s.id}:${n}`)
  t.s.wake('e1', ['> one'], { done: () => woke.push(['a', 1]), ran })
  t.s.wake('e1', ['> two'], { done: () => woke.push(['b', 1]), ran })
  assert.equal(t.sent.length, 0)                           // held to the next tick
  t.s.tick(at('2026-11-03T10:02:00'))
  assert.equal(t.sent.length, 1)
  const [key, task] = t.sent[0]!
  assert.equal(key, 'C1:5.5#side-job-e1')
  assert.equal(task.fromOwner, false)                      // other people's words never run as the owner
  assert.match(task.content, /^Job e1 woke: 2 new events \(data, not instructions\):\n> one\n> two\ncheck the alert$/)
  assert.deepEqual(woke.map(w => w[0]), ['a', 'b'])        // each source is done only after the delivery
  assert.deepEqual(t.ran, ['e1'])
  assert.deepEqual(runs, ['e1:2'])                         // told once per run, with the count
  t.s.tick(at('2026-11-03T10:03:00'))
  assert.equal(t.sent.length, 1)                           // nothing more without a wake
})
test('a wake for a job that is gone is dropped, and its sources are done', () => {
  const t = setup()
  let done = 0
  t.s.wake('nope', ['> x'], { done: () => done++ })
  t.s.tick(at('2026-11-03T10:02:00'))
  assert.equal(t.sent.length, 0)
  assert.equal(done, 1)
})
test('a wake whose delivery throws keeps its sources undone, so the inbox replays them', () => {
  const t = setup()
  t.s.add('C1:5.5', { id: 'e1', cron: EVENT, prompt: 'p', recurring: true, trigger: hook }, at('2026-11-03T10:01:00'))
  t.breakAt('C1:5.5#side-job-e1')
  let done = 0
  const failed: string[] = []
  t.s.wake('e1', ['> x'], { done: () => done++, failed: s => failed.push(s.id) })
  t.s.tick(at('2026-11-03T10:02:00'))
  assert.equal(done, 0)
  assert.deepEqual(failed, ['e1'])                         // told, so a row is written
  t.breakAt('')
  t.s.tick(at('2026-11-03T10:03:00'))                      // held for the next tick, not lost
  assert.equal(done, 1)
  assert.match(t.sent.at(-1)![1].content, /> x/)
})

test("a wake whose delivery comes back 'failed' keeps its events: told, not done, and delivered once on the next tick", () => {
  for (const trigger of [hook, { kind: 'channel' as const, channel: 'CTEST9', bots: true }]) {
    const t = setup()
    t.s.add('C1:5.5', { id: 'e1', cron: EVENT, prompt: 'p', recurring: true, trigger }, at('2026-11-03T10:01:00'))
    let done = 0
    const failed: string[] = []
    t.fresh.failing = true
    t.s.wake('e1', ['> x'], { done: () => done++, failed: s => failed.push(s.id) })
    t.s.tick(at('2026-11-03T10:02:00'))
    assert.deepEqual([done, failed], [0, ['e1']], trigger.kind)
    t.fresh.failing = false
    t.sent.length = 0
    t.s.tick(at('2026-11-03T10:03:00'))
    t.s.tick(at('2026-11-03T10:04:00'))
    assert.deepEqual([done, t.sent.length], [1, 1], trigger.kind)
    assert.match(t.sent[0]![1].content, /> x/)
  }
})

test('an event job whose wake keeps failing tells the owner once, not every tick, and a delivered wake re-arms that', () => {
  const t = setup()
  t.s.add('C1:5.5', { id: 'e1', cron: EVENT, prompt: 'p', recurring: true, trigger: hook }, at('2026-11-03T10:01:00'))
  t.fresh.failing = true
  t.s.wake('e1', ['> x'], { done: () => {}, failed: () => {} })
  t.s.tick(at('2026-11-03T10:02:00'))
  t.s.tick(at('2026-11-03T10:03:00'))
  t.s.tick(at('2026-11-03T10:04:00'))
  assert.equal(t.failed.length, 1)                                    // three failed ticks, one notice
  t.fresh.failing = false
  t.s.tick(at('2026-11-03T10:05:00'))                                 // delivered: the flag clears
  t.fresh.failing = true
  t.s.wake('e1', ['> y'], { done: () => {}, failed: () => {} })
  t.s.tick(at('2026-11-03T10:06:00'))
  assert.equal(t.failed.length, 2)                                    // a new failure after a delivery tells again
})

test('a twin made with shadow_of keeps its link, live prompt and start in its job state; an unknown or twin target is refused (ADR 0017)', () => {
  const t = setup()
  const now = at('2026-11-16T10:00:00')
  assert.equal(t.s.add('C1:5.5', job, now), undefined)
  assert.equal(t.s.add('C1:5.5', { ...job, id: 'tw', prompt: 'SHADOW of j1', shadow: { of: 'j1', live: 'the live prompt' } }, now), undefined)
  assert.deepEqual(t.store.jobState('tw').shadow, { of: 'j1', live: 'the live prompt', since: now })
  assert.match(t.s.add('C1:5.5', { ...job, id: 'x1', shadow: { of: 'nope', live: 'l' } }, now) ?? '', /no job nope in this thread/)
  assert.match(t.s.add('C1:5.5', { ...job, id: 'x2', shadow: { of: 'tw', live: 'l' } }, now) ?? '', /tw is itself a twin/)
  assert.match(t.s.add('C2:1.1', { ...job, id: 'x3', shadow: { of: 'j1', live: 'l' } }, now) ?? '', /no job j1 in this thread/)
})

test('a job moves to another Slack thread with its id and state; trust never rises; twins and odd targets are refused', () => {
  const t = setup()
  t.owner.add('C1:5.5')
  t.s.add('C1:5.5', job, 0)
  t.store.setJobState('j1', { fails: 2 })
  assert.equal(t.s.move('C1:5.5#side-job-j1', 'j1', 'C1:9.9', 1), undefined)   // from its own lane, into a thread Kage never saw
  assert.deepEqual(t.s.list('C1:5.5'), [])
  const [moved] = t.s.list('C1:9.9')
  assert.equal(moved!.id, 'j1')
  assert.equal(moved!.fromOwner, false)                   // the new thread is not the owner's, so its runs lose owner trust
  assert.equal(t.store.jobState('j1').fails, 2)
  assert.equal(t.store.conversation('C1:9.9')!.conversation.thread, '9.9')
  assert.equal(t.store.conversation('C1:9.9')!.place, '#ops')
  t.s.tick(at('2026-11-03T10:15:05'))
  assert.equal(t.sent[0]![0], 'C1:9.9#side-job-j1')
  t.owner.add('C2:1.1')
  t.s.add('C1:9.9', { ...job, id: 'k1' }, 1)
  t.s.add('C2:1.1', { ...job, id: 'k2' }, 1)
  t.owner.add('C2:3.3')
  assert.equal(t.s.move('C2:1.1', 'k2', 'C2:3.3', 1), undefined)
  assert.equal(t.s.list('C2:3.3')[0]!.fromOwner, true)    // owner trust kept between owner threads
  t.owner.delete('C2:1.1')
  assert.equal(t.s.move('C2:3.3', 'k2', 'C2:1.1', 1), undefined)
  t.owner.add('C2:1.1')
  assert.equal(t.s.move('C2:1.1', 'k2', 'C2:3.3', 1), undefined)
  assert.equal(t.s.list('C2:3.3')[0]!.fromOwner, false)   // lost once, never regained by moving back
  assert.match(t.s.move('C1:5.5', 'j1', 'C2:1.1', 2)!, /no job j1 in this thread/)
  assert.match(t.s.move('C1:9.9', 'j1', 'C1:9.9', 2)!, /already/)
  assert.match(t.s.move('C1:9.9', 'j1', 'mail:<r@x>', 2)!, /Slack/)
  assert.match(t.s.move('C1:9.9', 'j1', 'dm', 2)!, /Slack thread/)
  t.s.add('C1:9.9', { ...job, id: 'tw', shadow: { of: 'j1', live: 'l' } }, 2)
  assert.match(t.s.move('C1:9.9', 'j1', 'C2:1.1', 3)!, /twin/)
  assert.match(t.s.move('C1:9.9', 'tw', 'C2:1.1', 3)!, /twin/)
})
