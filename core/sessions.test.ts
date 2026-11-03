import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { Dispatcher, liveCronJobs, mixWindows, type Windows } from './sessions.ts'

describe('one Claude session per thread', () => {
  // A fake tmux: records starts and stops; activity times are set per key.
  function setup(o: { max?: number; saved?: Record<string, string>; busyThrows?: boolean } = {}) {
    const started: [string, string][] = []
    const stopped: string[] = []
    const activity = new Map<string, number>()
    const busy = new Set<string>()
    const watching = new Set<string>()    // busy only because a timed check (cron job) is alive
    const broken = new Set<string>()      // keys whose window fails to open
    let n = 0
    const d = new Dispatcher<string>(
      {
        start: (k, id) => { if (broken.has(k)) throw new Error('tmux failed'); started.push([k, id]) },
        stop: k => stopped.push(k),
        lastActivity: k => activity.get(k) ?? 0,
        busy: k => { if (o.busyThrows) throw new Error('tmux capture failed'); return busy.has(k) || (watching.has(k) ? 'watching' : false) },
      },
      { max: o.max ?? 2, idleMs: 1000, connectMs: 100, evictMs: 300, newId: () => `id${++n}`, saved: o.saved },
    )
    const inbox = (k: string) => { const got: string[] = []; d.connect(k, m => got.push(m)); return got }
    return { d, started, stopped, activity, busy, watching, broken, inbox }
  }

  test('a new thread starts a session and gets its task once the session connects', () => {
    const { d, started, inbox } = setup()
    assert.equal(d.task('A', 'first', 0), 'starting')
    assert.deepEqual(started, [['A', 'id1']])
    assert.deepEqual(inbox('A'), ['first'])
  })
  test('a follow-up goes to the running session of its thread, no new session', () => {
    const { d, started, inbox } = setup()
    d.task('A', 'first', 0)
    const got = inbox('A')
    assert.equal(d.task('A', 'second', 1), 'sent')
    assert.deepEqual(got, ['first', 'second'])
    assert.equal(started.length, 1)
  })
  test('tasks that arrive while a session restarts wait, in order', () => {
    const { d, inbox } = setup()
    d.task('A', 'first', 0)
    const old = inbox('A')
    d.disconnect('A', () => {})          // a stale socket closing changes nothing
    assert.equal(d.task('A', 'second', 1), 'sent')
    d.disconnect('A', d.connection('A')!)
    assert.equal(d.task('A', 'third', 2), 'starting')
    d.task('A', 'fourth', 3)
    assert.deepEqual(old, ['first', 'second'])
    assert.deepEqual(inbox('A'), ['third', 'fourth'])
  })
  test('over the limit, a new thread waits until a session closes', () => {
    const { d, started, stopped, activity, inbox } = setup({ max: 1 })
    d.task('A', 'a', 0)
    inbox('A')
    assert.equal(d.task('B', 'b', 0), 'queued')
    assert.deepEqual(started.map(s => s[0]), ['A'])
    activity.set('A', 0)
    d.sweep(5000)
    assert.deepEqual(stopped, ['A'])
    assert.deepEqual(started.map(s => s[0]), ['A', 'B'])
  })
  test('over the limit, the idlest quiet session closes so a new thread starts at once', () => {
    const { d, started, stopped, activity, inbox } = setup({ max: 2 })
    d.task('A', 'a', 0); inbox('A')
    d.task('B', 'b', 0); inbox('B')
    activity.set('A', 100)
    activity.set('B', 200)
    assert.equal(d.task('C', 'c', 900), 'starting')
    assert.deepEqual(stopped, ['A'])
    assert.deepEqual(started.map(s => s[0]), ['A', 'B', 'C'])
    assert.deepEqual(inbox('C'), ['c'])
    // A comes back later in its own session, by evicting the next quiet one.
    assert.equal(d.task('A', 'again', 2000), 'starting')
    assert.deepEqual(stopped, ['A', 'B'])
    assert.deepEqual(started.at(-1), ['A', 'id1'])
  })
  test('a waiting thread gets the slot once a session has been quiet long enough, not only after the idle close', () => {
    const { d, started, stopped, activity, inbox } = setup({ max: 1 })
    d.task('A', 'a', 0); inbox('A'); activity.set('A', 0)
    assert.equal(d.task('B', 'b', 100), 'queued')      // A quiet only 100 ms
    d.sweep(400)                                         // A quiet 400 ms > evictMs 300, < idleMs 1000
    assert.deepEqual(stopped, ['A'])
    assert.deepEqual(started.map(s => s[0]), ['A', 'B'])
  })
  test('a session whose busy check fails counts as busy, and the new task still waits safely', () => {
    const { d, stopped, inbox } = setup({ max: 1, busyThrows: true })
    d.task('A', 'a', 0); inbox('A')
    assert.equal(d.task('B', 'b', 5000), 'queued')
    assert.deepEqual(stopped, [])
  })
  test('a busy, asking, starting or just-active session is never evicted; then the thread waits', () => {
    const { d, stopped, activity, busy, inbox } = setup({ max: 4 })
    d.task('busy', 'x', 0); inbox('busy'); busy.add('busy')
    d.task('asking', 'x', 0); inbox('asking'); d.permission('asking', 'abcde')
    d.task('starting', 'x', 0)                  // never connected: its task is still pending
    d.task('fresh', 'x', 0); inbox('fresh'); activity.set('fresh', 800)
    assert.equal(d.task('new', 'n', 1000), 'queued')
    assert.deepEqual(stopped, [])
  })
  test('a session working recently, or with tasks not yet delivered, is not closed', () => {
    const { d, stopped, activity, inbox } = setup()
    d.task('A', 'a', 0)
    inbox('A')
    activity.set('A', 4500)              // Claude wrote to its transcript 0.5 s ago
    d.task('B', 'b', 4950)               // B has not connected yet, still within connectMs
    d.sweep(5000)
    assert.deepEqual(stopped, [])
    d.task('A', 'again', 4900)           // a new task counts as activity too
    activity.set('A', 0)
    d.sweep(5000)
    assert.deepEqual(stopped, [])
  })
  test('status names each live session as busy, asking, starting or quiet, and the threads waiting', () => {
    const { d, activity, busy, inbox } = setup({ max: 4 })
    d.task('A', 'a', 0); inbox('A'); busy.add('A')
    d.task('B', 'b', 0); inbox('B'); d.permission('B', 'abcde')
    d.task('C', 'c', 0)                          // not connected yet
    d.task('D', 'd', 0); inbox('D'); activity.set('D', 1000)
    d.task('E', 'e', 0)                          // full, nobody quiet long enough: waits
    assert.deepEqual(d.status(1200), {
      live: [
        { key: 'A', state: 'busy', quietMs: 1200 },
        { key: 'B', state: 'asking', quietMs: 1200 },
        { key: 'C', state: 'starting', quietMs: 1200 },
        { key: 'D', state: 'quiet', quietMs: 200 },
      ],
      waiting: ['E'],
      held: [],
      max: 4,
    })
  })
  test('a session held open only by a timed check is watching, and is still kept: no stop, no hold, no early restart', () => {
    const { d, watching, inbox } = setup({ max: 4 })
    d.task('A', 'a', 0); inbox('A'); watching.add('A')
    d.task('B', 'b', 0); inbox('B')
    assert.deepEqual(d.status(9_999).live.map(l => l.state), ['watching', 'quiet'])
    assert.deepEqual(d.stop('A', 9_999), { refused: 'busy' })
    assert.deepEqual(d.hold('A', 9_999), { refused: 'busy' })
    assert.equal(d.quietEverywhere(9_999), false)
    d.sweep(99_999)                       // long idle: a plain session closes, a watching one stays
    assert.deepEqual(d.status(99_999).live.map(l => l.key), ['A'])
    assert.equal(d.ready('A'), 'busy')
  })
  test('a watching session that asks for approval says it asks', () => {
    const { d, watching, inbox } = setup()
    d.task('A', 'a', 0); inbox('A'); watching.add('A'); d.permission('A', 'abcde')
    assert.equal(d.status(9_999).live[0]!.state, 'asking')
  })
  test('real work wins over watching', () => {
    const { d, busy, watching, inbox } = setup()
    d.task('A', 'a', 0); inbox('A'); watching.add('A'); busy.add('A')
    assert.equal(d.status(9_999).live[0]!.state, 'busy')
  })
  test('a closed or restarted thread resumes its saved session id', () => {
    const { d, started, activity, inbox } = setup({ saved: { A: 'old-id' } })
    d.task('A', 'a', 0)
    inbox('A')
    assert.deepEqual(started, [['A', 'old-id']])
    activity.set('A', 0)
    d.sweep(5000)
    d.task('A', 'later', 6000)
    assert.deepEqual(started, [['A', 'old-id'], ['A', 'old-id']])
    assert.deepEqual(d.saved(), { A: 'old-id' })
  })
  test('windows found running after a router restart are reused, not started again', () => {
    const { d, started, inbox } = setup({ saved: { A: 'old-id' } })
    d.adopt(['A', 'unknown'], 0)
    assert.equal(d.task('A', 'a', 0), 'starting')
    assert.deepEqual(started, [])
    assert.deepEqual(inbox('A'), ['a'])
  })
  test('only a known thread may connect', () => {
    const { d } = setup()
    assert.equal(d.connect('nobody', () => {}), false)
  })
  test('an approval goes only to the session that asked for it', () => {
    const { d } = setup()
    d.task('A', 'a', 0); d.task('B', 'b', 0)
    const a: string[] = [], b: string[] = []
    d.connect('A', m => a.push(m)); d.connect('B', m => b.push(m))
    d.permission('B', 'abcde')
    assert.equal(d.verdict('abcde', 'yes'), true)
    assert.equal(d.verdict('zzzzz', 'yes'), false)
    assert.deepEqual([a, b], [['a'], ['b', 'yes']])
  })
  test('a window that fails to open gives its task back and holds no slot', () => {
    const { d, broken, started } = setup({ max: 1 })
    broken.add('A')
    assert.equal(d.task('A', 'a', 0), 'failed')
    assert.equal(d.task('B', 'b', 0), 'starting')
    assert.deepEqual(started.map(s => s[0]), ['B'])
  })
  test('a window that never connects is closed and its tasks are handed back', () => {
    const { d, stopped, started } = setup({ max: 1 })
    d.task('A', 'a1', 0)
    d.task('A', 'a2', 10)
    d.task('B', 'b', 10)
    assert.deepEqual(d.sweep(50), [])     // still within connectMs
    assert.deepEqual(d.sweep(200), ['a1', 'a2'])
    assert.deepEqual(stopped, ['A'])
    assert.deepEqual(started.map(s => s[0]), ['A', 'B'])
  })
  test('a queued thread whose window fails to open is handed back by the sweep', () => {
    const { d, broken, activity, inbox } = setup({ max: 1 })
    d.task('A', 'a', 0)
    inbox('A')
    broken.add('B')
    d.task('B', 'b', 0)
    activity.set('A', 0)
    assert.deepEqual(d.sweep(5000), ['b'])
  })
  test('a busy session, or one waiting on an approval, is never closed for being idle', () => {
    const { d, stopped, busy, inbox } = setup()
    d.task('A', 'a', 0); inbox('A')
    d.task('B', 'b', 0); inbox('B')
    busy.add('A')
    d.permission('B', 'abcde')
    d.sweep(5000)
    assert.deepEqual(stopped, [])
    d.verdict('abcde', 'yes')
    d.sweep(5000)
    assert.deepEqual(stopped, ['B'])
  })
  test('a long-running window that is only restarting gets the full connect time again', () => {
    const { d, stopped, inbox } = setup()
    d.task('A', 'a', 0)
    inbox('A')
    d.disconnect('A', d.connection('A')!)  // Claude Code exited at 10 s; the loop brings it back
    d.task('A', 'b', 10_000)
    assert.deepEqual(d.sweep(10_050), [])
    assert.deepEqual(stopped, [])
    assert.deepEqual(d.sweep(10_200), ['b'])
  })
  test('an adopted window that never reconnects times out too', () => {
    const { d, stopped } = setup({ saved: { A: 'old-id' } })
    d.adopt(['A'], 0)
    d.task('A', 'a', 0)
    assert.deepEqual(d.sweep(200), ['a'])
    assert.deepEqual(stopped, ['A'])
  })
  test('an approval from a session that went away no longer keeps its window open', () => {
    const { d, stopped, inbox } = setup()
    d.task('A', 'a', 0)
    inbox('A')
    d.permission('A', 'abcde')
    d.disconnect('A', d.connection('A')!)
    d.sweep(5000)
    assert.deepEqual(stopped, ['A'])
    assert.equal(d.verdict('abcde', 'yes'), false)
  })
  test('the id a thread gets is reported when it starts, so the router can save it', () => {
    const { d, started, activity, inbox } = setup({ max: 1 })
    d.task('A', 'a', 0); inbox('A')
    d.task('B', 'b', 0)
    activity.set('A', 0)
    d.sweep(5000)
    assert.deepEqual(started, [['A', 'id1'], ['B', 'id2']])
    assert.deepEqual(d.saved(), { A: 'id1', B: 'id2' })
  })

  // Terminal handoff: the owner takes a thread's session into a terminal, then gives it back.
  test('holding a thread closes its session and gives its id; tasks wait, and release brings them back', () => {
    const { d, started, stopped, inbox } = setup()
    d.task('A', 'first', 0); inbox('A')
    assert.deepEqual(d.hold('A', 9_999), { id: 'id1' })
    assert.deepEqual(stopped, ['A'])
    assert.equal(d.task('A', 'while away', 1), 'held')
    assert.equal(started.length, 1)                       // nothing starts while the terminal has it
    assert.deepEqual(d.sweep(10_000), [])                 // and nothing is dropped for not connecting
    d.release('A', 10_001)
    assert.deepEqual(started, [['A', 'id1'], ['A', 'id1']])
    assert.deepEqual(inbox('A'), ['while away'])
  })
  test('tasks that cannot start on release come back, so the owner hears about them', () => {
    const { d, broken, inbox } = setup()
    d.task('A', 'first', 0); inbox('A')
    d.hold('A', 9_999)
    d.task('A', 'while away', 1)
    broken.add('A')
    assert.deepEqual(d.release('A', 2), ['while away'])
  })
  test('a held thread with no waiting task starts nothing on release; its next task resumes it', () => {
    const { d, started, inbox } = setup()
    d.task('A', 'first', 0); inbox('A')
    d.hold('A', 9_999)
    d.release('A', 1)
    assert.equal(started.length, 1)
    assert.equal(d.task('A', 'next', 2), 'starting')
    assert.deepEqual(started.at(-1), ['A', 'id1'])
  })
  test('a busy or asking session, an unknown thread or one already held is not handed over', () => {
    const { d, busy, inbox } = setup()
    d.task('A', 'a', 0); inbox('A')
    busy.add('A')
    assert.deepEqual(d.hold('A', 9_999), { refused: 'busy' })
    busy.delete('A')
    d.permission('A', 'abcde')
    assert.deepEqual(d.hold('A', 9_999), { refused: 'asking' })
    assert.deepEqual(d.hold('Z', 9_999), { refused: 'unknown' })
    d.task('B', 'b', 0); inbox('B')
    d.hold('B', 9_999)
    assert.deepEqual(d.hold('B', 9_999), { refused: 'held' })
  })
  test('a session just handed a task counts as busy, even before it shows any work', () => {
    const { d, inbox } = setup()
    d.task('A', 'a', 0); inbox('A')
    d.task('A', 'b', 1000)
    assert.deepEqual(d.hold('A', 1100), { refused: 'busy' })   // within evictMs (300) of the task
    assert.deepEqual(d.hold('A', 1400), { id: 'id1' })
  })
  // Stop from the console: close one session. Its next task resumes it, so nothing is lost.
  test('stopping a quiet session closes it; the thread resumes on its next task', () => {
    const { d, started, stopped, inbox } = setup()
    d.task('A', 'first', 0); inbox('A')
    assert.deepEqual(d.stop('A', 1000), { ok: true })
    assert.deepEqual(stopped, ['A'])
    assert.equal(d.task('A', 'later', 1001), 'starting')
    assert.deepEqual(started.at(-1), ['A', 'id1'])
  })
  test('a session that works, asks, is starting, just got a task, or is not running is not stopped', () => {
    const { d, busy, stopped, inbox } = setup({ max: 4 })
    d.task('A', 'a', 0); inbox('A'); busy.add('A')
    assert.deepEqual(d.stop('A', 9_999), { refused: 'busy' })
    d.task('B', 'b', 0); inbox('B'); d.permission('B', 'abcde')
    assert.deepEqual(d.stop('B', 9_999), { refused: 'asking' })
    d.task('C', 'c', 0)
    assert.deepEqual(d.stop('C', 9_999), { refused: 'starting' })
    d.task('D', 'd', 0); inbox('D')
    assert.deepEqual(d.stop('D', 100), { refused: 'busy' })   // within evictMs (300) of its task
    assert.deepEqual(d.stop('Z', 9_999), { refused: 'closed' })
    d.hold('D', 9_999)
    assert.deepEqual(d.stop('D', 9_999), { refused: 'closed' })
    assert.deepEqual(stopped, ['D'])                           // only the hold closed anything
  })
  test('the hub may restart itself only when every session is quiet and nothing waits or is held', () => {
    const { d, busy, inbox } = setup({ max: 1 })
    assert.equal(d.quietEverywhere(0), true)              // nothing running at all
    d.task('A', 'a', 0)
    assert.equal(d.quietEverywhere(0), false)             // starting
    inbox('A')
    busy.add('A')
    assert.equal(d.quietEverywhere(5000), false)          // mid-turn
    busy.delete('A')
    assert.equal(d.quietEverywhere(5000), true)
    d.permission('A', 'abcde')
    assert.equal(d.quietEverywhere(5000), false)          // an approval would be lost
    d.verdict('abcde', 'yes')
    d.task('B', 'b', 5000)
    assert.equal(d.quietEverywhere(5001), false)          // B waits for a slot
  })
  test('a session that just answered is not quiet yet for a self-restart', () => {
    const { d, inbox } = setup()
    d.task('A', 'a', 0); inbox('A')
    assert.equal(d.quietEverywhere(100), false)   // within evictMs (300)
    assert.equal(d.quietEverywhere(400), true)
  })
  test('a thread is ready for a scheduled run only when nothing else is in flight for it', () => {
    const { d, busy, inbox } = setup({ max: 1 })
    assert.equal(d.ready('A'), 'ready')                      // closed: a run just starts it
    d.task('A', 'a', 0)
    assert.equal(d.ready('A'), 'blocked')                     // starting, task pending
    inbox('A')
    busy.add('A')
    assert.equal(d.ready('A'), 'busy')                    // mid-turn
    busy.delete('A')
    assert.equal(d.ready('A'), 'ready')
    d.task('B', 'b', 0)
    assert.equal(d.ready('B'), 'blocked')                     // queued for a slot
    d.hold('A', 9_999)
    assert.equal(d.ready('A'), 'blocked')                     // in a terminal
  })
  test('a held thread also blocks a self-restart', () => {
    const { d, inbox } = setup()
    d.task('A', 'a', 0); inbox('A')
    d.hold('A', 9_999)
    assert.equal(d.quietEverywhere(9_999), false)
  })
  test('a thread waiting for a slot can be held, and leaves the queue until release', () => {
    const { d, started, inbox } = setup({ max: 1, saved: { B: 'old' } })
    d.task('A', 'a', 0); inbox('A')
    assert.equal(d.task('B', 'b', 0), 'queued')
    assert.deepEqual(d.hold('B', 9_999), { id: 'old' })
    assert.deepEqual(d.status(0).waiting, [])
    assert.equal(started.length, 1)
  })
})

describe('a session with a repeating check stays open', () => {
  const H = 3600_000
  const at = (h: number) => new Date(Date.UTC(2026, 10, 1) + h * H).toISOString()
  const made = (id: string, h: number, kind = 'recurring') => ({ timestamp: at(h), text: `Scheduled ${kind} job ${id} (*/5 * * * *). Next run: ...` })
  const cancelled = (id: string, h: number) => ({ timestamp: at(h), text: `Cancelled job ${id}.` })
  const t0 = Date.parse(at(0))

  test('a job made by the running process counts until it is cancelled', () => {
    assert.deepEqual(liveCronJobs([made('aa11', 1)], t0, t0 + 2 * H), ['aa11'])
    assert.deepEqual(liveCronJobs([made('aa11', 1), cancelled('aa11', 2)], t0, t0 + 3 * H), [])
  })
  test('a job made before this process started died with the old one', () => {
    assert.deepEqual(liveCronJobs([made('aa11', 1)], t0 + 2 * H, t0 + 3 * H), [])
  })
  test('a recurring job expires after 7 days, a one-shot after a day', () => {
    assert.deepEqual(liveCronJobs([made('aa11', 1)], t0, t0 + 7 * 24 * H + 2 * H), [])
    assert.deepEqual(liveCronJobs([made('bb22', 1, 'one-shot')], t0, t0 + 3 * H), ['bb22'])
    assert.deepEqual(liveCronJobs([made('bb22', 1, 'one-shot')], t0, t0 + 26 * H), [])
  })
})

describe('switching runtime without closing the panes that run', () => {
  const fake = (name: string, calls: string[]): Windows => ({
    start: k => { calls.push(`${name} start ${k}`) },
    stop: k => { calls.push(`${name} stop ${k}`) },
    lastActivity: () => (name === 'pane' ? 1 : 2),
    busy: () => name === 'pane',
  })
  test('a thread whose pane still runs stays in it; anything started from now on runs on the new runtime', () => {
    const calls: string[] = []
    const w = mixWindows(fake('pane', calls), fake('sdk', calls), new Set(['A', 'C']))
    w.start('C', 'id-c')          // a pane that died on its own: never restarted as a pane
    assert.equal(w.busy('C'), false)
    calls.length = 0
    assert.equal(w.busy('A'), true)
    assert.equal(w.lastActivity('A'), 1)
    assert.equal(w.busy('B'), false)
    w.start('B', 'id-b')
    w.stop('A')                   // the pane closes
    w.start('A', 'id-a')          // its next task resumes the same conversation on the new runtime
    assert.equal(w.busy('A'), false)
    w.stop('A')
    assert.deepEqual(calls, ['sdk start B', 'pane stop A', 'sdk start A', 'sdk stop A'])
  })
})
