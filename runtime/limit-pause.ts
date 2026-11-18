import { clockTime } from '../core/board.ts'
import type { Task } from '../core/task.ts'
import type { Store } from './store.ts'
import { logKey } from './log.ts'

export type Limit = { kind: 'rate_limit' | 'overloaded'; until?: number; window?: string }
const RETRY = { rate_limit: 15 * 60_000, overloaded: 5 * 60_000 }

const sourceOf = (t: Task) => (t.scheduled ? undefined : t.source ?? (t.origin.ts ? `slack:${t.origin.channel}:${t.origin.ts}` : undefined))

export function limitPause(o: {
  store: Pick<Store, 'delivered' | 'hold' | 'held' | 'release' | 'handled' | 'load' | 'save'>
  notice: (task: Task, text: string) => void
  end: (key: string) => Task[] | void
  replay: (row: { source: string; connector: string; payload: string }) => Promise<unknown>
  redeliver: (key: string, task: Task) => void
  log: (...a: unknown[]) => void
  tellOwner: (text: string) => void
  event?: (detail: string) => void
  defers?: (key: string) => boolean
  settle?: (tasks: Task[], done: boolean) => void
  time?: (at: number, now: number) => string
}) {
  let until: number | undefined
  let drainUntil = 0
  const open = new Set<string>()
  const TOLD = 'limit-told'
  const told = (o.store.load(TOLD) ?? {}) as Record<string, number>
  const threadOf = (key: string) => key.split('#')[0]!
  function setTold(key: string, at: number | undefined, now: number) {
    if (at === undefined) delete told[threadOf(key)]
    else told[threadOf(key)] = at
    for (const [k, v] of Object.entries(told)) if (v < now - 30 * 60_000) delete told[k]
    o.store.save(TOLD, Object.keys(told).length ? told : undefined)
  }
  const owed = new Map<string, { key: string; task: Task }>()
  const counts = { limitHits: 0, held: 0, replays: 0, replayFailures: 0 }

  function keep(key: string, t: Task, limit: Limit, now: number): boolean {
    const source = sourceOf(t)
    if (source && o.store.hold(source, until!)) open.add(source)
    else if (t.scheduled && t.job) owed.set(t.job, { key, task: t })
    else return false
    counts.held++
    if (until! > Math.max(drainUntil, now) && until! - (told[threadOf(key)] ?? -Infinity) > 30 * 60_000) {
      setTold(key, until!, now)
      const at = (o.time ?? clockTime)(until!, now)
      o.notice(t, limit.kind === 'overloaded' ? `Paused: Claude is overloaded. I'll try again at ${at}.` : `Paused by the usage limit until ${at}. I'll pick this up then.`)
    }
    return true
  }
  let kind: Limit['kind'] = 'rate_limit'
  let probing: string | undefined

  return {
    counts,
    paused: (now = Date.now()) => (until === undefined ? undefined
      : { until, held: o.store.held().length + owed.size, ...(now < drainUntil && { draining: true as const }) }),
    draining: (now: number) => now < drainUntil,
    drain(now: number) {
      drainUntil = now + 10_000
      until = Math.max(until ?? 0, drainUntil)
    },
    restore() { for (const r of o.store.held()) until = Math.max(until ?? 0, r.until) },
    hold(key: string, t: Task, now: number): boolean {
      if (until === undefined) return false
      if (!t.scheduled && !probing && now >= drainUntil) {
        probing = threadOf(key)
        o.log('a new message in the pause: trying it once to see whether the limit lifted')
        return false
      }
      return keep(key, t, { kind }, now)
    },
    delivered(key: string, t: Task) {
      const source = sourceOf(t)
      if (source && (o.defers?.(key) ?? true) && o.store.delivered(source)) open.add(source)
    },
    handled(source: string) { if (!open.has(source)) o.store.handled(source) },
    turn(key: string, tasks: Task[], limit: Limit | undefined, now: number, done = false) {
      if (!limit) {
        o.settle?.(tasks, done)
        if (probing === threadOf(key) && until !== undefined) { probing = undefined; o.log('the limit lifted early'); void lift() }
        if (key === threadOf(key) && key in told) setTold(key, undefined, now)
        for (const t of tasks) { const s = sourceOf(t); if (s && open.delete(s)) o.store.handled(s) }
        return
      }
      if (probing === threadOf(key)) probing = undefined
      counts.limitHits++
      kind = limit.kind
      const resets = limit.until && limit.until > now ? limit.until : now + RETRY[limit.kind]
      until = Math.max(until ?? 0, resets)
      o.log(`${limit.kind === 'overloaded' ? 'overload' : 'usage limit'} hit in ${key}: paused until ${new Date(until).toISOString()}, ${tasks.length} task${tasks.length === 1 ? '' : 's'} held`)
      const all = [...tasks, ...o.end(key) ?? []]
      o.event?.(`${limit.kind}${limit.window ? ` window=${limit.window}` : ''} wait_s=${Math.round((resets - now) / 1000)} held=${all.length}`)
      o.settle?.(all, false)
      for (const t of all) if (!keep(key, t, limit, now) && !t.handoff) o.log('cannot hold a task with no inbox message', logKey(key), t.meta.place)
    },
    async tick(now: number) { if (until !== undefined && now >= until) await lift() },
  }
  async function lift() {
    {
      until = undefined
      const rows = o.store.held()
      o.log(`the pause is over: replaying ${rows.length} held message${rows.length === 1 ? '' : 's'} and ${owed.size} scheduled run${owed.size === 1 ? '' : 's'}`)
      const lost: string[] = []
      for (const r of rows) {
        o.store.release(r.source)
        open.delete(r.source)
        try { await o.replay(r); counts.replays++ } catch (e) {
          counts.replayFailures++
          o.log('replay failed', r.source, e)
          o.store.handled(r.source)
          lost.push(r.source)
        }
      }
      if (lost.length) o.tellOwner(`After the usage limit, ${lost.length} held message${lost.length === 1 ? '' : 's'} could not be resumed: ${lost.join(', ')}. Ask again in ${lost.length === 1 ? 'its thread' : 'their threads'}.`)
      for (const [job, { key, task }] of [...owed]) { owed.delete(job); counts.replays++; o.redeliver(key, task) }
    }
  }
}
