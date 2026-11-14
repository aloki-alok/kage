import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { Dispatcher, mixRunners, type Runner } from './sessions.ts'

describe('one Claude session per thread', () => {
  // A fake tmux: records starts and stops; activity times are set per key.
  function setup(o: { max?: number; saved?: Record<string, string>; busyThrows?: boolean } = {}) {
    const started: [string, string][] = []
    const stopped: string[] = []
    const activity = new Map<string, number>()
    const busy = new Set<string>()
    const watching = new Set<string>()    // busy only because a timed check (cron job) is alive
    const broken = new Set<string>()      // keys whose session fails to open
    const panes = new Set<string>()       // keys whose session outlives a hub restart (a tmux pane)
    let n = 0
    const d = new Dispatcher<string>(
      {
        start: (k, id) => { if (broken.has(k)) throw new Error('tmux failed'); started.push([k, id]) },
        stop: k => stopped.push(k),
        lastActivity: k => activity.get(k) ?? 0,
        busy: k => { if (o.busyThrows) throw new Error('tmux capture failed'); return busy.has(k) || (watching.has(k) ? 'watching' : false) },
        outlivesHub: k => panes.has(k),
      },
      { max: o.max ?? 2, idleMs: 1000, connectMs: 100, evictMs: 300, newId: () => `id${++n}`, saved: o.saved },
    )
    const inbox = (k: string) => { const got: string[] = []; d.connect(k, m => got.push(m)); return got }
    return { d, started, stopped, activity, busy, watching, broken, panes, inbox }
  }

  test('a new thread starts a session and gets its task once the session connects', () => {
    const { d, started, inbox } = setup()
    assert.equal(d.task('A', 'first', 0), 'starting')
    assert.deepEqual(started, [['A', 'id1']])
    assert.deepEqual(inbox('A'), ['first'])
  })
  test('hasFreeSlot: a live thread or an open slot, never one that would evict or jump the queue', () => {
    const { d } = setup({ max: 2 })
    d.task('A', 'a', 0)
    assert.equal(d.hasFreeSlot('A'), true)    // already live
    assert.equal(d.hasFreeSlot('B'), true)    // a slot is open
    d.task('B', 'b', 0)
    assert.equal(d.hasFreeSlot('C'), false)   // full: starting C would evict a quiet session
    assert.equal(d.hasFreeSlot('A'), true)
  })
  test('startsNow: like a schedule, a full house still starts a thread when a quiet session can give up its slot', () => {
    const { d, busy, inbox } = setup({ max: 2 })
    d.task('A', 'a', 0); inbox('A')
    d.task('B', 'b', 0); inbox('B')
    assert.equal(d.startsNow('C', 100), false)   // both just active
    assert.equal(d.startsNow('C', 1000), true)   // both quiet past evictMs
    busy.add('A'); busy.add('B')
    assert.equal(d.startsNow('C', 1000), false)  // both mid-turn
    assert.equal(d.startsNow('A', 1000), true)   // already live
  })
  test('stopping a thread lets its turn finish, then ends the session at the next sweep', () => {
    const { d, stopped, busy, inbox } = setup()
    d.task('A', 'a', 0); inbox('A'); busy.add('A')
    assert.deepEqual(d.endThread('A', 10, false), { ok: true, ending: true, dropped: [] })
    d.sweep(20)
    assert.deepEqual(stopped, [])          // still mid-turn
    busy.delete('A')
    d.sweep(30)
    assert.deepEqual(stopped, ['A'])
  })
  test('a new task for a thread that is ending keeps its session', () => {
    const { d, stopped, busy, inbox } = setup()
    d.task('A', 'a', 0); inbox('A'); busy.add('A')
    d.endThread('A', 10, false)
    d.task('A', 'again', 20)
    busy.delete('A')
    d.sweep(30)
    assert.deepEqual(stopped, [])
  })
  test('stop now cuts a turn in progress and says what it cut; a quiet session just ends', () => {
    const { d, stopped, busy, inbox } = setup()
    d.task('A', 'a', 0); inbox('A'); busy.add('A')
    assert.deepEqual(d.endThread('A', 10, true), { ok: true, cut: 'busy', dropped: [] })
    d.task('B', 'b', 0); inbox('B')
    assert.deepEqual(d.endThread('B', 10, false), { ok: true, dropped: [] })
    assert.deepEqual(stopped, ['A', 'B'])
  })
  test('stop now also returns the tasks queued behind the turn it cut, so their messages are let go', () => {
    const { d, busy, inbox } = setup()
    d.task('A', 'a', 0); inbox('A'); busy.add('A')
    d.task('A', 'queued', 5)               // sent mid-turn: the session may never read it
    assert.deepEqual(d.endThread('A', 10, true), { ok: true, cut: 'busy', dropped: ['queued'] })
  })
  test('a session that asks for approval is not ended by a plain stop: it waits, and says so', () => {
    const { d, stopped, inbox } = setup()
    d.task('A', 'a', 0); inbox('A')
    d.permission('A', 'abcde')
    assert.deepEqual(d.endThread('A', 10, false), { ok: true, ending: true, asking: true, dropped: [] })
    d.sweep(20)
    assert.deepEqual(stopped, [])
  })
  test('stopping a thread waiting for a slot drops its task and returns it; an unknown thread is refused', () => {
    const { d } = setup({ max: 1 })
    d.task('A', 'a', 0)
    d.task('B', 'b', 0)                    // A is still starting, so B waits for the slot
    assert.deepEqual(d.endThread('B', 10, false), { ok: true, dropped: ['b'] })
    assert.deepEqual(d.status(10).waiting, [])
    assert.deepEqual(d.endThread('Z', 10, false), { refused: 'closed' })
  })
  test('end closes only that thread and forgets its waiting task', () => {
    const { d, stopped, inbox } = setup({ max: 1 })
    d.task('A', 'a', 0)
    d.task('B', 'b', 0)                                  // full: B waits
    d.end('B')
    d.end('nobody')
    assert.deepEqual(stopped, [])
    assert.equal(d.status(0).waiting.length, 0)
    d.end('A')
    assert.deepEqual(stopped, ['A'])
    assert.equal(d.hasFreeSlot('C'), true)
    assert.deepEqual(inbox('A'), [])                     // no longer live: it does not connect
  })
  test('reset closes the thread and its next task starts a new conversation, not the old one', () => {
    const { d, started, stopped } = setup({ saved: { A: 'old' } })
    d.task('A', 'a', 0)
    d.reset('A')
    assert.deepEqual(stopped, ['A'])
    assert.equal(d.saved().A, undefined)
    d.task('A', 'again', 1)
    assert.deepEqual(started, [['A', 'old'], ['A', 'id1']])
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
  test('sessions found running after a router restart are reused, not started again', () => {
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
  test('a session that fails to open gives its task back and holds no slot', () => {
    const { d, broken, started } = setup({ max: 1 })
    broken.add('A')
    assert.equal(d.task('A', 'a', 0), 'failed')
    assert.equal(d.task('B', 'b', 0), 'starting')
    assert.deepEqual(started.map(s => s[0]), ['B'])
  })
  test('a session that never connects is closed and its tasks are handed back', () => {
    const { d, stopped, started } = setup({ max: 1 })
    d.task('A', 'a1', 0)
    d.task('A', 'a2', 10)
    d.task('B', 'b', 10)
    assert.deepEqual(d.sweep(50), [])     // still within connectMs
    assert.deepEqual(d.sweep(200), ['a1', 'a2'])
    assert.deepEqual(stopped, ['A'])
    assert.deepEqual(started.map(s => s[0]), ['A', 'B'])
  })
  test('a queued thread whose session fails to open is handed back by the sweep', () => {
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
  test('a long-running session that is only restarting gets the full connect time again', () => {
    const { d, stopped, inbox } = setup()
    d.task('A', 'a', 0)
    inbox('A')
    d.disconnect('A', d.connection('A')!)  // Claude Code exited at 10 s; the loop brings it back
    d.task('A', 'b', 10_000)
    assert.deepEqual(d.sweep(10_050), [])
    assert.deepEqual(stopped, [])
    assert.deepEqual(d.sweep(10_200), ['b'])
  })
  test('an adopted session that never reconnects times out too', () => {
    const { d, stopped } = setup({ saved: { A: 'old-id' } })
    d.adopt(['A'], 0)
    d.task('A', 'a', 0)
    assert.deepEqual(d.sweep(200), ['a'])
    assert.deepEqual(stopped, ['A'])
  })
  test('an approval from a session that went away no longer keeps its session open', () => {
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
    assert.deepEqual(d.hold('A'), { id: 'id1' })
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
    d.hold('A')
    d.task('A', 'while away', 1)
    broken.add('A')
    assert.deepEqual(d.release('A', 2), ['while away'])
  })
  test('a held thread with no waiting task starts nothing on release; its next task resumes it', () => {
    const { d, started, inbox } = setup()
    d.task('A', 'first', 0); inbox('A')
    d.hold('A')
    d.release('A', 1)
    assert.equal(started.length, 1)
    assert.equal(d.task('A', 'next', 2), 'starting')
    assert.deepEqual(started.at(-1), ['A', 'id1'])
  })
  // Attach is Esc in Claude Code: the owner gets the session now, whatever it is doing.
  test('attach takes a busy, asking or watching session at once: its turn stops and the terminal gets the id', () => {
    for (const [what, cut] of [['busy', 'busy'], ['asking', 'asking'], ['watching', 'watching']] as const) {
      const { d, busy, watching, inbox, stopped } = setup()
      d.task('A', 'a', 0); inbox('A')
      if (what === 'busy') busy.add('A')
      if (what === 'asking') d.permission('A', 'abcde')
      if (what === 'watching') watching.add('A')
      assert.deepEqual(d.hold('A'), { id: 'id1', cut })
      assert.deepEqual(stopped, ['A'])
      assert.equal(d.task('A', 'while attached', 5), 'held')      // new tasks wait for the terminal
    }
  })
  test('tasks that reached a busy session after its turn began are kept when attach cuts it, and go to it after', () => {
    const { d, busy, inbox } = setup()
    d.task('A', 'start', 0); const got = inbox('A')
    busy.add('A')
    assert.equal(d.task('A', 'one more thing', 1), 'sent')       // queued behind the turn, maybe never read
    assert.deepEqual(d.hold('A'), { id: 'id1', cut: 'busy' })
    d.release('A', 9)
    assert.deepEqual(inbox('A'), ['one more thing'])            // 'start' began the cut turn: it is in the transcript
    assert.deepEqual(got, ['start', 'one more thing'])
  })
  test('a quiet session is handed over with nothing cut; an unknown thread or one already held is refused', () => {
    const { d, inbox } = setup()
    d.task('A', 'a', 0); inbox('A')
    assert.deepEqual(d.hold('A'), { id: 'id1' })
    assert.deepEqual(d.hold('A'), { refused: 'held' })
    assert.deepEqual(d.hold('Z'), { refused: 'unknown' })
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
    d.hold('D')
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
    d.hold('A')
    assert.equal(d.ready('A'), 'blocked')                     // in a terminal
  })
  test('a pane kept only by its timed check does not block a self-restart: the pane outlives the hub', () => {
    const { d, busy, watching, panes, inbox } = setup()
    d.task('A', 'a', 0); inbox('A'); watching.add('A'); panes.add('A')
    assert.equal(d.quietEverywhere(9_999), true)
    panes.delete('A')
    assert.equal(d.quietEverywhere(9_999), false)             // an in-hub session's check dies with the hub
    panes.add('A'); busy.add('A')
    assert.equal(d.quietEverywhere(9_999), false)             // a pane mid-turn could lose a reply in the gap
  })
  test('unquiet names every thread a restart would wait on, and why', () => {
    const { d, busy, watching, panes, inbox } = setup({ max: 7, saved: { I: 'old' } })
    assert.deepEqual(d.unquiet(0), [])
    d.task('A', 'a', 0); inbox('A'); busy.add('A')
    d.task('B', 'b', 0); inbox('B'); d.permission('B', 'abcde')
    d.task('C', 'c', 0)
    d.task('D', 'd', 0); inbox('D'); watching.add('D')
    d.task('E', 'e', 9_900); inbox('E')
    d.task('F', 'f', 0); inbox('F'); watching.add('F'); panes.add('F')   // a pane outlives the hub, check and all
    d.task('G', 'g', 0); inbox('G')                                      // quiet long enough
    d.task('H', 'h', 0)                                                  // over max: waits for a slot
    d.task('I', 'i', 0); inbox('I'); d.hold('I')
    assert.deepEqual(d.unquiet(10_000), [
      { key: 'A', why: 'busy' },
      { key: 'B', why: 'asking' },
      { key: 'C', why: 'starting' },
      { key: 'D', why: 'watching' },
      { key: 'E', why: 'just active' },
      { key: 'H', why: 'waiting for a slot' },
      { key: 'I', why: 'open in a terminal' },
    ])
    assert.equal(d.quietEverywhere(10_000), false)
  })
  test('a held thread also blocks a self-restart', () => {
    const { d, inbox } = setup()
    d.task('A', 'a', 0); inbox('A')
    d.hold('A')
    assert.equal(d.quietEverywhere(9_999), false)
  })
  test('a thread waiting for a slot can be held, and leaves the queue until release', () => {
    const { d, started, inbox } = setup({ max: 1, saved: { B: 'old' } })
    d.task('A', 'a', 0); inbox('A')
    assert.equal(d.task('B', 'b', 0), 'queued')
    assert.deepEqual(d.hold('B'), { id: 'old' })
    assert.deepEqual(d.status(0).waiting, [])
    assert.equal(started.length, 1)
  })
})

describe('switching runtime without closing the panes that run', () => {
  const fake = (name: string, calls: string[]): Runner => ({
    start: k => { calls.push(`${name} start ${k}`) },
    stop: k => { calls.push(`${name} stop ${k}`) },
    lastActivity: () => (name === 'pane' ? 1 : 2),
    busy: () => name === 'pane',
    ...(name === 'pane' ? { outlivesHub: () => true } : {}),
  })
  test('a thread whose pane still runs stays in it; anything started from now on runs on the new runtime', () => {
    const calls: string[] = []
    const w = mixRunners(fake('pane', calls), fake('sdk', calls), new Set(['A', 'C']))
    w.start('C', 'id-c')          // a pane that died on its own: never restarted as a pane
    assert.equal(w.busy('C'), false)
    calls.length = 0
    assert.equal(w.busy('A'), true)
    assert.equal(w.lastActivity('A'), 1)
    assert.equal(w.outlivesHub!('A'), true)     // a pane survives a hub restart
    assert.equal(w.outlivesHub!('B'), false)    // a session on the new runtime does not
    assert.equal(w.busy('B'), false)
    w.start('B', 'id-b')
    w.stop('A')                   // the pane closes
    w.start('A', 'id-a')          // its next task resumes the same conversation on the new runtime
    assert.equal(w.busy('A'), false)
    w.stop('A')
    assert.deepEqual(calls, ['sdk start B', 'pane stop A', 'sdk start A', 'sdk stop A'])
  })
})

test('ending a thread hands back the tasks it still held for a session that had not read them', () => {
  const d = new Dispatcher<string>({ start: () => {}, stop: () => {}, lastActivity: () => 0, busy: () => false }, { max: 1, idleMs: 9e9, connectMs: 9e9, evictMs: 0, newId: () => 'id' })
  d.task('A', 'one', 0)       // starting, not connected yet
  d.task('A', 'two', 1)
  assert.deepEqual(d.end('A'), ['one', 'two'])
  assert.deepEqual(d.end('A'), [])
})
