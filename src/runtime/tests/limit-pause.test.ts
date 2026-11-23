import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { limitPause } from '../limit-pause.ts'
import type { Task } from '../../core/task.ts'
import { openStore } from '../store.ts'

const MIN = 60_000
const slackTask = (ts: string, channel = 'C1', thread = '5.5'): Task => ({
  type: 'task', content: `Task from Sam: ${ts}`, fromOwner: false,
  meta: { channel, thread_ts: thread, place: '#general', permalink: '' }, origin: { channel, ts },
})
const run = (job: string, channel = 'C1', thread = '5.5'): Task => ({
  type: 'task', content: `Scheduled run of job ${job}`, fromOwner: true, scheduled: true, job,
  meta: { channel, thread_ts: thread, place: '#general', permalink: '' }, origin: { channel, ts: '' },
})

function hub() {
  const store = openStore(':memory:')
  const notices: string[] = [], events: string[] = [], toldOwner: string[] = [], ended: string[] = [], replayed: string[] = [], redelivered: string[] = [], logged: string[] = []
  let failReplay = false
  const pendingAtEnd: Task[] = []
  const p = limitPause({
    store, time: at => `t+${at / MIN}`,
    notice: (task, text) => notices.push(`${task.meta.channel}:${task.meta.thread_ts} ${text}`),
    end: key => { ended.push(key); return pendingAtEnd.splice(0) },
    replay: async r => { if (failReplay) throw new Error('slack down'); replayed.push(`${r.source} ${r.payload}`) },
    redeliver: (key, task) => redelivered.push(`${key} ${task.job}`),
    log: (...a) => logged.push(a.join(' ')),
    tellOwner: text => toldOwner.push(text),
    event: d => events.push(d),
  })
  const hear = (key: string, t: Task, now: number, payload = `event ${t.origin.ts}`) => {
    const source = `slack:${t.origin.channel}:${t.origin.ts}`
    store.take(source, 'slack', payload, now)
    const paused = p.paused(now)
    const held = p.hold(key, t, now)
    if (!held) p.delivered(key, t)
    p.handled(source)
    if (!held && paused && paused.until > now && !paused.draining) { p.turn(key, [t], { kind: 'rate_limit', until: paused.until }, now); return true }
    return held
  }
  return { store, p, notices, events, toldOwner, ended, replayed, redelivered, logged, hear, pendingAtEnd, failReplays: () => { failReplay = true } }
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
  test('a WhatsApp, GitHub or meeting message is held and replayed too, not only a Slack one', async () => {
    for (const [source, connector] of [['wa:true_1@c.us_AAA', 'whatsapp'], ['github:d-1', 'github'], ['meeting:ab12', 'meeting']] as const) {
      const h = hub()
      const t: Task = { type: 'task', content: 'a message', fromOwner: true, source,
        meta: { channel: 'whatsapp', thread_ts: '1@c.us', place: 'WhatsApp chat', permalink: '' }, origin: { channel: 'whatsapp', ts: '1@c.us' } }
      h.store.take(source, connector, 'payload', 0)
      assert.equal(h.p.hold('wa:1@c.us', t, 0), false)
      h.p.delivered('wa:1@c.us', t)
      h.p.handled(source)
      h.p.turn('wa:1@c.us', [t], { kind: 'rate_limit', until: 55 * MIN }, 1000)
      assert.deepEqual(h.store.held().map(r => r.source), [source], connector)
      assert.deepEqual(h.logged.filter(l => l.startsWith('cannot hold')), [], connector)
      await h.p.tick(55 * MIN)
      assert.deepEqual(h.replayed, [`${source} payload`], connector)
    }
  })
  test('a turn that ends well marks its message handled, and only then', () => {
    const h = hub()
    const t = slackTask('7.7')
    h.hear('C1:5.5', t, 0)
    assert.equal(h.store.delivered('slack:C1:7.7'), true)
    h.p.turn('C1:5.5', [t], undefined, 1000)
    assert.equal(h.store.delivered('slack:C1:7.7'), false)
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
    assert.deepEqual(h.notices.map(n => n.split(' ')[0]), ['C1:5.5', 'C2:1.1'])
    assert.deepEqual(h.p.paused(), { until: 55 * MIN, held: 4 })
    assert.deepEqual(h.ended, ['C1:5.5', 'C1:5.5', 'C1:5.5', 'C2:1.1'])
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
    assert.equal(h.hear('C1:5.5', first, 56 * MIN), false)
    await h.p.tick(56 * MIN)
    assert.equal(h.replayed.length, 3)
  })
  test("any new message tries in a pause, a teammate's too, and a turn that gets through ends the pause and replays the rest", async () => {
    const h = hub()
    const first = slackTask('7.7')
    h.hear('C1:5.5', first, 0)
    h.p.turn('C1:5.5', [first], { kind: 'rate_limit', until: 7 * 24 * 60 * MIN }, 1000)
    const mine = slackTask('8.8', 'C2', '1.1')
    assert.equal(h.p.hold('C2:1.1', mine, 2000), false)
    assert.equal(h.p.hold('C2:1.1', { ...mine, scheduled: true, job: 'j' }, 2000), true)
    await h.p.turn('C2:1.1', [mine], undefined, 3000, true)
    await new Promise(r => setImmediate(r))
    assert.equal(h.p.paused(), undefined)
    assert.deepEqual(h.replayed, ['slack:C1:7.7 event 7.7'])
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
    await h.p.tick(80 * MIN)
    h.p.delivered('C1:5.5', t)
    h.p.turn('C1:5.5', [t], undefined, 81 * MIN)
    const next = slackTask('9.9')
    h.hear('C1:5.5', next, 82 * MIN)
    h.p.turn('C1:5.5', [next], { kind: 'rate_limit', until: 140 * MIN }, 83 * MIN)
    assert.equal(h.notices.length, 2)
  })
  test('a turn that ends cleanly forgets the notice, so the next pause soon after is told again', async () => {
    const h = hub()
    const t = slackTask('7.7')
    h.hear('C1:5.5', t, 0)
    h.p.turn('C1:5.5', [t], { kind: 'rate_limit', until: 55 * MIN }, 1000)
    await h.p.tick(55 * MIN)
    h.p.delivered('C1:5.5', t)
    h.p.turn('C1:5.5', [t], undefined, 56 * MIN)
    const next = slackTask('9.9')
    h.hear('C1:5.5', next, 57 * MIN)
    h.p.turn('C1:5.5', [next], { kind: 'rate_limit', until: 70 * MIN }, 58 * MIN)
    assert.equal(h.notices.length, 2)
  })
  test('each limit it meets is one event: its kind, window, seconds to the reset and tasks held, never the thread', () => {
    const h = hub()
    const t = slackTask('7.7')
    h.hear('C1:5.5', t, 0)
    h.p.turn('C1:5.5', [t], { kind: 'rate_limit', until: 55 * MIN, window: 'five_hour' }, 10 * MIN)
    h.p.turn('C2:1.1', [], { kind: 'overloaded' }, 20 * MIN)
    assert.deepEqual(h.events, ['rate_limit window=five_hour wait_s=2700 held=1', 'overloaded wait_s=300 held=0'])
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
    assert.equal(store.delivered('slack:C1:7.7'), false)
    assert.deepEqual(store.held(), [])
  })
  test('a restart inside the pause keeps it: held messages wait for the reset, then replay', async () => {
    const h = hub()
    const t = slackTask('7.7')
    h.hear('C1:5.5', t, 0)
    h.p.turn('C1:5.5', [t], { kind: 'rate_limit', until: 55 * MIN }, 1000)
    const replayed: string[] = []
    const again = limitPause({ store: h.store, notice: () => {}, end: () => {}, replay: async r => { replayed.push(r.source) }, redeliver: () => {}, log: () => {}, tellOwner: () => {} })
    assert.deepEqual(h.store.unhandled(30 * MIN), [])
    again.restore()
    assert.deepEqual(again.paused(), { until: 55 * MIN, held: 1 })
    await again.tick(30 * MIN)
    assert.deepEqual(replayed, [])
    await again.tick(55 * MIN)
    assert.deepEqual(replayed, ['slack:C1:7.7'])
  })
  test('a thread told before a hub restart is not told again in the same pause', () => {
    const h = hub()
    const t = slackTask('7.7')
    h.hear('C1:5.5', t, 0)
    h.p.turn('C1:5.5', [t], { kind: 'rate_limit', until: 55 * MIN }, 1000)
    const notices: string[] = []
    const again = limitPause({ store: h.store, notice: (_, text) => notices.push(text), end: () => {}, replay: async () => {}, redeliver: () => {}, log: () => {}, tellOwner: () => {} })
    again.restore()
    h.store.take('slack:C1:8.8', 'slack', 'event 8.8', 20 * MIN)
    assert.equal(again.hold('C1:5.5', slackTask('8.8'), 20 * MIN), false)
    assert.equal(again.hold('C1:5.5', run('job1'), 21 * MIN), true)
    assert.deepEqual(notices, [])
    h.store.take('slack:C2:1.1', 'slack', 'event 1.1', 22 * MIN)
    assert.equal(again.hold('C2:1.1', slackTask('1.1', 'C2', '1.1'), 22 * MIN), true)
    assert.equal(notices.length, 1)
  })
  test('the side lanes of a thread share its one notice: they post in the same thread', () => {
    const h = hub()
    const t = slackTask('7.7')
    h.hear('C1:5.5', t, 0)
    h.p.turn('C1:5.5', [t], { kind: 'rate_limit', until: 55 * MIN }, 1000)
    assert.equal(h.p.hold('C1:5.5#side-kagelet-watch', run('kagelet-watch'), 15 * MIN), true)
    assert.equal(h.p.hold('C1:5.5#side-kagelet-other', run('kagelet-other'), 16 * MIN), true)
    assert.equal(h.notices.length, 1)
    h.p.turn('C1:5.5#side-x', [], undefined, 17 * MIN)
    h.store.take('slack:C1:8.8', 'slack', 'event 8.8', 18 * MIN)
    h.store.take('slack:C1:9.9', 'slack', 'event 9.9', 18 * MIN)
    assert.equal(h.p.hold('C1:5.5', slackTask('8.8'), 18 * MIN), false)
    assert.equal(h.p.hold('C1:5.5', slackTask('9.9'), 18 * MIN), true)
    assert.equal(h.notices.length, 1)
  })
  test('a task the dispatcher still had for the thread when its session closed is held too', () => {
    const h = hub()
    const first = slackTask('7.7'), second = slackTask('8.8')
    h.hear('C1:5.5', first, 0)
    h.hear('C1:5.5', second, 500)
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
    await h.p.tick(55 * MIN)
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
    assert.deepEqual(h.p.counts, { limitHits: 2, held: 2, replays: 0, replayFailures: 0 })
    h.failReplays()
    await h.p.tick(55 * MIN)
    assert.deepEqual(h.p.counts, { limitHits: 2, held: 2, replays: 0, replayFailures: 2 })
    assert.equal(h.logged.filter(l => l.includes('replay failed')).length, 2)
    assert.equal(h.store.held().length, 0)
    assert.equal(h.store.delivered('slack:C1:7.7'), false)
    assert.equal(h.p.paused(), undefined)
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
    h.p.drain(5000)
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
  test('a turn that hits the usage limit while a drain waits still tells its thread', () => {
    const h = hub()
    const t = slackTask('7.7')
    h.hear('C1:5.5', t, 0)
    h.p.drain(500)
    h.p.turn('C1:5.5', [t], { kind: 'rate_limit', until: 55 * MIN }, 1000)
    assert.equal(h.notices.length, 1)
    assert.match(h.notices[0]!, /usage limit until t\+55/)
  })
  test('a message after a lapsed drain, before the tick clears it, gets no false usage-limit notice', () => {
    const h = hub()
    h.p.drain(0)
    h.hear('C1:5.5', slackTask('7.7'), 12_000)
    assert.deepEqual(h.notices, [])
  })
})

test('every task list a turn or a stop ends is settled once: done only for a turn that ended with its result', () => {
  const settled: string[] = []
  const pending = [run('b')]
  const p = limitPause({ store: openStore(':memory:'), notice: () => {}, end: () => pending.splice(0), replay: async () => {}, redeliver: () => {}, log: () => {}, tellOwner: () => {},
    settle: (ts, done) => settled.push(`${ts.map(t => t.job ?? t.origin.ts).join(',')} ${done}`) })
  p.turn('k', [slackTask('1.1')], undefined, 0, true)
  p.turn('k', [slackTask('2.2')], undefined, 0)
  p.turn('k', [run('a')], { kind: 'rate_limit' }, 0, true)
  assert.deepEqual(settled, ['1.1 true', '2.2 false', 'a,b false'])
})
