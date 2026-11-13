// The usage-limit pause. A turn that ends on Claude's usage limit, or on an overload, did no work: its
// message stays in the inbox, its thread gets one notice, and the message replays at the reset time. While
// paused, new messages are held the same way and no session starts. A replay goes through the gate again
// (the original Slack event), so it runs with the trust of whoever wrote it.
import { clockTime } from '../core/board.ts'
import type { Task } from './protocol.ts'
import type { Store } from './store.ts'

// until: when the limit resets (ms), when Claude said.
export type Limit = { kind: 'rate_limit' | 'overloaded'; until?: number }
const RETRY = { rate_limit: 15 * 60_000, overloaded: 5 * 60_000 }

// A Slack task's inbox id, as connectors/slack.ts takes it. Other tasks have no inbox message to replay.
const sourceOf = (t: Task) => (t.origin.ts && !t.scheduled ? `slack:${t.origin.channel}:${t.origin.ts}` : undefined)

export function limitPause(o: {
  store: Pick<Store, 'delivered' | 'hold' | 'held' | 'release' | 'handled'>
  notice: (task: Task, text: string) => void           // one line in the task's thread, as the bot
  // Close the session, so it reads nothing more into the limit. Returns the tasks it had not read yet.
  end: (key: string) => Task[] | void
  replay: (row: { source: string; connector: string; payload: string }) => Promise<unknown>
  redeliver: (key: string, task: Task) => void         // a scheduled run, again
  log: (...a: unknown[]) => void
  tellOwner: (text: string) => void                    // a DM to the owner
  // false for a session whose runner reports no turn end (a tmux pane): its messages are handled at delivery.
  defers?: (key: string) => boolean
  time?: (at: number, now: number) => string
}) {
  let until: number | undefined
  const open = new Set<string>()                              // inbox ids that wait for their turn to end
  // Thread -> the reset time it was told. Told again only for a reset more than 30 minutes later, so a
  // retry every 15 minutes with no known reset does not post every time.
  const told = new Map<string, number>()
  // ponytail: scheduled runs wait in memory, so a hub restart in the pause drops them. A recurring one runs at its next time.
  const owed = new Map<string, { key: string; task: Task }>() // job id -> the one run it gets at the reset
  const counts = { limitHits: 0, held: 0, replays: 0, replayFailures: 0 }

  // Keeps the task for the reset. false: it has no inbox message and is no scheduled run, so nothing can replay it.
  function keep(key: string, t: Task, limit: Limit, now: number): boolean {
    const source = sourceOf(t)
    if (source && o.store.hold(source, until!)) open.add(source)
    else if (t.scheduled && t.job) owed.set(t.job, { key, task: t })
    else return false
    counts.held++
    if (until! - (told.get(key) ?? -Infinity) > 30 * 60_000) {
      told.set(key, until!)
      const at = (o.time ?? clockTime)(until!, now)
      o.notice(t, limit.kind === 'overloaded' ? `Paused: Claude is overloaded. I'll try again at ${at}.` : `Paused by the usage limit until ${at}. I'll pick this up then.`)
    }
    return true
  }
  let kind: Limit['kind'] = 'rate_limit'

  return {
    counts,
    paused: () => (until === undefined ? undefined : { until, held: o.store.held().length + owed.size }),
    // After a hub start: messages held before it keep the pause.
    restore() { for (const r of o.store.held()) until = Math.max(until ?? 0, r.until) },
    // Before a task goes to a session. true: paused, and the task is held for the reset.
    hold: (key: string, t: Task, now: number): boolean => until !== undefined && keep(key, t, { kind }, now),
    // A session took the task: its inbox message waits for the turn to end.
    delivered(key: string, t: Task) {
      const source = sourceOf(t)
      if (source && (o.defers?.(key) ?? true) && o.store.delivered(source)) open.add(source)
    },
    // What connectors call after they delivered a message. One that waits for its turn, or for the reset, stays.
    handled(source: string) { if (!open.has(source)) o.store.handled(source) },
    // A turn ended, or its session closed. No limit: its messages are handled. A limit: they are held, and the pause starts or moves.
    turn(key: string, tasks: Task[], limit: Limit | undefined, now: number) {
      if (!limit) {
        told.delete(key)
        for (const t of tasks) { const s = sourceOf(t); if (s && open.delete(s)) o.store.handled(s) }
        return
      }
      counts.limitHits++
      kind = limit.kind
      until = Math.max(until ?? 0, limit.until && limit.until > now ? limit.until : now + RETRY[limit.kind])
      o.log(`${limit.kind === 'overloaded' ? 'overload' : 'usage limit'} hit in ${key}: paused until ${new Date(until).toISOString()}, ${tasks.length} task${tasks.length === 1 ? '' : 's'} held`)
      // The session closes first: what the dispatcher still had for it was never read, and is held with the rest.
      for (const t of [...tasks, ...o.end(key) ?? []]) if (!keep(key, t, limit, now)) o.log('cannot hold a task with no inbox message', key, t.meta.place)
    },
    // At the reset time: held messages replay oldest first, then each owed scheduled run once.
    async tick(now: number) {
      if (until === undefined || now < until) return
      until = undefined
      const rows = o.store.held()
      o.log(`the pause is over: replaying ${rows.length} held message${rows.length === 1 ? '' : 's'} and ${owed.size} scheduled run${owed.size === 1 ? '' : 's'}`)
      const lost: string[] = []
      for (const r of rows) {
        o.store.release(r.source)
        open.delete(r.source)
        try { await o.replay(r); counts.replays++ } catch (e) {
          // Its connector is off or the event is unreadable, so a later try would fail the same way: it is let go.
          counts.replayFailures++
          o.log('replay failed', r.source, e)
          o.store.handled(r.source)
          lost.push(r.source)
        }
      }
      if (lost.length) o.tellOwner(`After the usage limit, ${lost.length} held message${lost.length === 1 ? '' : 's'} could not be resumed: ${lost.join(', ')}. Ask again in ${lost.length === 1 ? 'its thread' : 'their threads'}.`)
      for (const [job, { key, task }] of [...owed]) { owed.delete(job); counts.replays++; o.redeliver(key, task) }
    },
  }
}
