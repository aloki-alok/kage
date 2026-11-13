import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { limitPause } from './limit-pause.ts'
import type { Task } from './protocol.ts'
import { openStore } from './store.ts'

const MIN = 60_000
const slackTask = (ts: string, channel = 'C1', thread = '5.5'): Task => ({
  type: 'task', content: `Task from Sam: ${ts}`, fromOwner: true,
  meta: { channel, thread_ts: thread, place: '#general', permalink: '' }, origin: { channel, ts },
})
const run = (job: string, channel = 'C1', thread = '5.5'): Task => ({
  type: 'task', content: `Scheduled run of job ${job}`, fromOwner: true, scheduled: true, job,
  meta: { channel, thread_ts: thread, place: '#general', permalink: '' }, origin: { channel, ts: '' },
})

// A hub around the pause: a real store, and lists of what the pause asked the hub to do.
function hub() {
  const store = openStore(':memory:')
  const notices: string[] = [], toldOwner: string[] = [], ended: string[] = [], replayed: string[] = [], redelivered: string[] = [], logged: string[] = []
  let failReplay = false
  const pendingAtEnd: Task[] = []   // tasks the dispatcher still had for the thread when its session closed
  const p = limitPause({
    store, time: at => `t+${at / MIN}`,
    notice: (task, text) => notices.push(`${task.meta.channel}:${task.meta.thread_ts} ${text}`),
    end: key => { ended.push(key); return pendingAtEnd.splice(0) },
    replay: async r => { if (failReplay) throw new Error('slack down'); replayed.push(`${r.source} ${r.payload}`) },
    redeliver: (key, task) => redelivered.push(`${key} ${task.job}`),
    log: (...a) => logged.push(a.join(' ')),
    tellOwner: text => toldOwner.push(text),
  })
  // What a connector and the hub do with one Slack message: take it, deliver it (or hold it), then call handled.
  const hear = (key: string, t: Task, now: number, payload = `event ${t.origin.ts}`) => {
    const source = `slack:${t.origin.channel}:${t.origin.ts}`
    store.take(source, 'slack', payload, now)
    const held = p.hold(key, t, now)
    if (!held) p.delivered(key, t)
    p.handled(source)
    return held
  }
  return { store, p, notices, toldOwner, ended, replayed, redelivered, logged, hear, pendingAtEnd, failReplays: () => { failReplay = true } }
}

describe('a turn that ends on the usage limit', () => {
  test('keeps its message in the inbox with the reset time, closes the session, and posts one notice in the thread', () => {
    const h = hub()
    const t = slackTask('7.7')
    assert.equal(h.hear('C1:5.5', t, 0), false)
    h.p.turn('C1:5.5', [t], { kind: 'rate_limit', until: 55 * MIN }, 1000)
    assert.deepEqual(h.store.held(), [{ source: 'slack:C1:7.7', connector: 'slack', payload: 'event 7.7', at: 0, until: 55 * MIN }])
    assert.deepEqual(h.notices, ["C1:5.5 Paused by the usage limit until t+55. I'll pick this up then."])
    assert.deepEqual(h.ended, ['C1:5.5'])
    assert.deepEqual(h.p.paused(), { until: 55 * MIN, held: 1 })
    assert.deepEqual(h.replayed, [])
  })
  test('a turn that ends well marks its message handled, and only then', () => {
    const h = hub()
    const t = slackTask('7.7')
    h.hear('C1:5.5', t, 0)
    assert.equal(h.store.delivered('slack:C1:7.7'), true)    // its text is still there while the turn runs
    h.p.turn('C1:5.5', [t], undefined, 1000)
    assert.equal(h.store.delivered('slack:C1:7.7'), false)   // and gone once the turn ended, as before
    assert.equal(h.store.has('slack:C1:7.7'), true)
    assert.deepEqual(h.store.held(), [])
    assert.equal(h.p.paused(), undefined)
    assert.deepEqual(h.notices, [])
  })
  test('while paused, a new message is held the same way with no session, and its thread is told once', () => {
    const h = hub()
    const first = slackTask('7.7')
    h.hear('C1:5.5', first, 0)
    h.p.turn('C1:5.5', [first], { kind: 'rate_limit', until: 55 * MIN }, 1000)
    assert.equal(h.hear('C1:5.5', slackTask('8.8'), 2000), true)
    assert.equal(h.hear('C1:5.5', slackTask('9.9'), 3000), true)
    assert.equal(h.hear('C2:1.1', slackTask('1.1', 'C2', '1.1'), 4000), true)
    assert.deepEqual(h.store.held().map(r => r.source), ['slack:C1:7.7', 'slack:C1:8.8', 'slack:C1:9.9', 'slack:C2:1.1'])
    assert.deepEqual(h.notices.map(n => n.split(' ')[0]), ['C1:5.5', 'C2:1.1'])   // one per thread, not one per message
    assert.deepEqual(h.p.paused(), { until: 55 * MIN, held: 4 })
    assert.deepEqual(h.ended, ['C1:5.5'])
  })
  test('at the reset time, held messages replay oldest first with their original payload, and not before', async () => {
    const h = hub()
    const first = slackTask('7.7')
    h.hear('C1:5.5', first, 0)
    h.p.turn('C1:5.5', [first], { kind: 'rate_limit', until: 55 * MIN }, 1000)
    h.hear('C2:1.1', slackTask('1.1', 'C2', '1.1'), 4000)
    h.hear('C1:5.5', slackTask('8.8'), 5000)
    await h.p.tick(55 * MIN - 1)
    assert.deepEqual(h.replayed, [])
    await h.p.tick(55 * MIN)
    assert.deepEqual(h.replayed, ['slack:C1:7.7 event 7.7', 'slack:C2:1.1 event 1.1', 'slack:C1:8.8 event 8.8'])
    assert.equal(h.p.paused(), undefined)
    assert.deepEqual(h.store.held(), [])
    // A replayed message is an unhandled one again until its turn ends.
    assert.equal(h.hear('C1:5.5', first, 56 * MIN), false)
    await h.p.tick(56 * MIN)
    assert.equal(h.replayed.length, 3)   // nothing replays twice
  })
  test('a replayed turn that hits the limit again is held again, and its thread is not told a second time', async () => {
    const h = hub()
    const t = slackTask('7.7')
    h.hear('C1:5.5', t, 0)
    h.p.turn('C1:5.5', [t], { kind: 'rate_limit', until: 55 * MIN }, 1000)
    await h.p.tick(55 * MIN)
    h.p.delivered('C1:5.5', t)
    h.p.turn('C1:5.5', [t], { kind: 'rate_limit', until: 80 * MIN }, 56 * MIN)
    assert.equal(h.notices.length, 1)
    assert.deepEqual(h.p.paused(), { until: 80 * MIN, held: 1 })
    // Once a turn there ends well, the next pause tells the thread again.
    await h.p.tick(80 * MIN)
    h.p.delivered('C1:5.5', t)
    h.p.turn('C1:5.5', [t], undefined, 81 * MIN)
    const next = slackTask('9.9')
    h.hear('C1:5.5', next, 82 * MIN)
    h.p.turn('C1:5.5', [next], { kind: 'rate_limit', until: 140 * MIN }, 83 * MIN)
    assert.equal(h.notices.length, 2)
  })
  test('a limit with no reset time tries again in 15 minutes; an overload in 5, and says so', () => {
    const a = hub()
    const t = slackTask('7.7')
    a.hear('C1:5.5', t, 0)
    a.p.turn('C1:5.5', [t], { kind: 'rate_limit' }, 10 * MIN)
    assert.equal(a.p.paused()!.until, 25 * MIN)
    const b = hub()
    b.hear('C1:5.5', t, 0)
    b.p.turn('C1:5.5', [t], { kind: 'overloaded' }, 10 * MIN)
    assert.equal(b.p.paused()!.until, 15 * MIN)
    assert.deepEqual(b.notices, ["C1:5.5 Paused: Claude is overloaded. I'll try again at t+15."])
    // A reset time already in the past is no reset time.
    const c = hub()
    c.hear('C1:5.5', t, 0)
    c.p.turn('C1:5.5', [t], { kind: 'rate_limit', until: 5 * MIN }, 10 * MIN)
    assert.equal(c.p.paused()!.until, 25 * MIN)
  })
  test('a scheduled run that fails on the limit, or comes due in the pause, runs once at the reset', async () => {
    const h = hub()
    const r = run('job1')
    assert.equal(h.p.hold('C1:5.5', r, 0), false)
    h.p.delivered('C1:5.5', r)
    h.p.turn('C1:5.5', [r], { kind: 'rate_limit', until: 55 * MIN }, 1000)
    // The same job comes due twice more in the pause, and another job once.
    assert.equal(h.p.hold('C1:5.5', run('job1'), 20 * MIN), true)
    assert.equal(h.p.hold('C1:5.5', run('job1'), 40 * MIN), true)
    assert.equal(h.p.hold('C2:1.1', run('job2', 'C2', '1.1'), 41 * MIN), true)
    assert.deepEqual(h.p.paused(), { until: 55 * MIN, held: 2 })
    await h.p.tick(55 * MIN)
    assert.deepEqual(h.redelivered, ['C1:5.5 job1', 'C2:1.1 job2'])
    await h.p.tick(56 * MIN)
    assert.equal(h.redelivered.length, 2)
  })
  test('a task with no inbox message and no schedule cannot be held, so it is not', () => {
    const h = hub()
    const t = slackTask('7.7')
    h.hear('C1:5.5', t, 0)
    h.p.turn('C1:5.5', [t], { kind: 'rate_limit', until: 55 * MIN }, 1000)
    const mail: Task = { type: 'task', content: 'Email task', fromOwner: false, meta: { channel: 'email', thread_ts: 'mail:1', place: 'mail', permalink: '' }, origin: { channel: 'email', ts: 'mail:1' } }
    assert.equal(h.p.hold('mail:1', mail, 2000), false)
    assert.equal(h.p.paused()!.held, 1)
  })
  test('a session whose runner reports no turn end is not waited for: its message is handled at delivery, as before', () => {
    const store = openStore(':memory:')
    const p = limitPause({ store, notice: () => {}, end: () => {}, replay: async () => {}, redeliver: () => {}, log: () => {}, tellOwner: () => {}, defers: key => key !== 'pane' })
    store.take('slack:C1:7.7', 'slack', 'event', 0)
    p.delivered('pane', slackTask('7.7'))
    p.handled('slack:C1:7.7')
    assert.equal(store.delivered('slack:C1:7.7'), false)   // its text is gone at once
    assert.deepEqual(store.held(), [])
  })
  test('a restart inside the pause keeps it: held messages wait for the reset, then replay', async () => {
    const h = hub()
    const t = slackTask('7.7')
    h.hear('C1:5.5', t, 0)
    h.p.turn('C1:5.5', [t], { kind: 'rate_limit', until: 55 * MIN }, 1000)
    const replayed: string[] = []
    const again = limitPause({ store: h.store, notice: () => {}, end: () => {}, replay: async r => { replayed.push(r.source) }, redeliver: () => {}, log: () => {}, tellOwner: () => {} })
    assert.deepEqual(h.store.unhandled(30 * MIN), [])   // the start's own replay leaves a held message alone, however old
    again.restore()
    assert.deepEqual(again.paused(), { until: 55 * MIN, held: 1 })
    await again.tick(30 * MIN)
    assert.deepEqual(replayed, [])
    await again.tick(55 * MIN)
    assert.deepEqual(replayed, ['slack:C1:7.7'])
  })
  test('a task the dispatcher still had for the thread when its session closed is held too', () => {
    const h = hub()
    const first = slackTask('7.7'), second = slackTask('8.8')
    h.hear('C1:5.5', first, 0)
    h.hear('C1:5.5', second, 500)       // delivered, but the session was restarting: the dispatcher kept it
    h.pendingAtEnd.push(second)
    h.p.turn('C1:5.5', [first], { kind: 'rate_limit', until: 55 * MIN }, 1000)
    assert.deepEqual(h.store.held().map(r => r.source), ['slack:C1:7.7', 'slack:C1:8.8'])
    assert.equal(h.notices.length, 1)
  })
  test('a thread is told again in a later pause, even when no turn there ended well in between', async () => {
    const h = hub()
    const t = slackTask('7.7')
    h.hear('C1:5.5', t, 0)
    h.p.turn('C1:5.5', [t], { kind: 'rate_limit', until: 55 * MIN }, 1000)
    await h.p.tick(55 * MIN)            // its replay was dropped by the gate, so no turn ran
    h.p.handled('slack:C1:7.7')
    const later = slackTask('9.9')
    h.hear('C1:5.5', later, 300 * MIN)
    h.p.turn('C1:5.5', [later], { kind: 'rate_limit', until: 360 * MIN }, 301 * MIN)
    assert.equal(h.notices.length, 2)
    assert.match(h.notices[1]!, /until t\+360/)
  })
  test('limit hits, held messages, replays and replay failures are counted', async () => {
    const h = hub()
    const t = slackTask('7.7')
    h.hear('C1:5.5', t, 0)
    h.p.turn('C1:5.5', [t], { kind: 'rate_limit', until: 55 * MIN }, 1000)
    h.hear('C1:5.5', slackTask('8.8'), 2000)
    assert.deepEqual(h.p.counts, { limitHits: 1, held: 2, replays: 0, replayFailures: 0 })
    h.failReplays()
    await h.p.tick(55 * MIN)
    assert.deepEqual(h.p.counts, { limitHits: 1, held: 2, replays: 0, replayFailures: 2 })
    assert.equal(h.logged.filter(l => l.includes('replay failed')).length, 2)
    // A replay that fails cannot work later either (its connector is off, or the event is unreadable): it is let go, and the pause ends.
    assert.equal(h.store.held().length, 0)
    assert.equal(h.store.delivered('slack:C1:7.7'), false)
    assert.equal(h.p.paused(), undefined)
    // Let go is not lost silently: the owner hears once, with each message that did not come back.
    assert.equal(h.toldOwner.length, 1)
    assert.match(h.toldOwner[0]!, /slack:C1:7\.7/)
    assert.match(h.toldOwner[0]!, /slack:C1:8\.8/)
  })
})

describe('a drain before kage restart or kage stop', () => {
  test('new messages are held with no notice in the thread, and the pause says it is a drain', () => {
    const h = hub()
    h.p.drain(1000)
    assert.equal(h.hear('C1:5.5', slackTask('7.7'), 2000), true)
    assert.deepEqual(h.store.held().map(r => r.source), ['slack:C1:7.7'])
    assert.deepEqual(h.notices, [])
    assert.equal(h.p.paused(2000)?.draining, true)
  })
  test('a drain nobody renews ends after 10 s, and what it held replays', async () => {
    const h = hub()
    h.p.drain(0)
    h.hear('C1:5.5', slackTask('7.7'), 1000)
    h.p.drain(5000)                   // renewed: the lease now ends at 15 s
    await h.p.tick(12_000)
    assert.deepEqual(h.replayed, [])
    await h.p.tick(15_000)
    assert.deepEqual(h.replayed, ['slack:C1:7.7 event 7.7'])
    assert.equal(h.p.paused(15_000), undefined)
  })
  test('a drain inside a usage-limit pause keeps the later reset, and the limit notice still goes out', async () => {
    const h = hub()
    const t = slackTask('7.7')
    h.hear('C1:5.5', t, 0)
    h.p.turn('C1:5.5', [t], { kind: 'rate_limit', until: 55 * MIN }, 1000)
    h.p.drain(2000)
    assert.equal(h.p.paused(2000)?.until, 55 * MIN)
    assert.equal(h.notices.length, 1)
    await h.p.tick(13_000)
    assert.deepEqual(h.replayed, [])
  })
})
