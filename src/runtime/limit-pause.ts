import { clockTime } from '../core/board.ts'
import type { Task } from '../core/task.ts'
import type { Store } from './store.ts'
import { logKey } from './log.ts'
import { ownerLines } from '../core/messages.ts'

export type Limit = { kind: 'rate_limit' | 'overloaded'; until?: number; window?: string }
const RETRY = { rate_limit: 15 * 60_000, overloaded: 5 * 60_000 }

const sourceOf = (t: Task) => (t.scheduled ? undefined : t.source ?? (t.origin.ts ? `slack:${t.origin.channel}:${t.origin.ts}` : undefined))

type Options = {
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
}
type Pause = {
  o: Options; until?: number; drainUntil: number; open: Set<string>; told: Record<string, number>
  owed: Map<string, { key: string; task: Task }>; counts: { limitHits: number; held: number; replays: number; replayFailures: number }
  kind: Limit['kind']; probing?: string
}
const TOLD = 'limit-told'
const threadOf = (key: string) => key.split('#')[0]!

export function limitPause(o: Options) {
  const p: Pause = { o, drainUntil: 0, open: new Set(), told: (o.store.load(TOLD) ?? {}) as Record<string, number>, owed: new Map(), counts: { limitHits: 0, held: 0, replays: 0, replayFailures: 0 }, kind: 'rate_limit' }
  return {
    counts: p.counts,
    paused: (now = Date.now()) => (p.until === undefined ? undefined
      : { until: p.until, held: o.store.held().length + p.owed.size, ...(now < p.drainUntil && { draining: true as const }) }),
    draining: (now: number) => now < p.drainUntil,
    drain(now: number) {
      p.drainUntil = now + 10_000
      p.until = Math.max(p.until ?? 0, p.drainUntil)
    },
    restore() { for (const r of o.store.held()) p.until = Math.max(p.until ?? 0, r.until) },
    hold(key: string, t: Task, now: number): boolean {
      if (p.until === undefined) return false
      if (!t.scheduled && !p.probing && now >= p.drainUntil) {
        p.probing = threadOf(key)
        o.log('a new message in the pause: trying it once to see whether the limit lifted')
        return false
      }
      return keep(p, key, t, { kind: p.kind }, now)
    },
    delivered(key: string, t: Task) {
      const source = sourceOf(t)
      if (source && (o.defers?.(key) ?? true) && o.store.delivered(source)) p.open.add(source)
    },
    handled(source: string) { if (!p.open.has(source)) o.store.handled(source) },
    turn(key: string, tasks: Task[], limit: Limit | undefined, now: number, done = false) {
      if (limit) limited(p, key, tasks, limit, now)
      else cleared(p, key, tasks, now, done)
    },
    async tick(now: number) { if (p.until !== undefined && now >= p.until) await lift(p) },
  }
}

function setTold({ o, told }: Pause, key: string, at: number | undefined, now: number) {
  if (at === undefined) delete told[threadOf(key)]
  else told[threadOf(key)] = at
  for (const [k, v] of Object.entries(told)) if (v < now - 30 * 60_000) delete told[k]
  o.store.save(TOLD, Object.keys(told).length ? told : undefined)
}

function keep(p: Pause, key: string, t: Task, limit: Limit, now: number): boolean {
  const { o } = p
  const source = sourceOf(t)
  if (source && o.store.hold(source, p.until!)) p.open.add(source)
  else if (t.scheduled && t.job) p.owed.set(t.job, { key, task: t })
  else return false
  p.counts.held++
  if (p.until! > Math.max(p.drainUntil, now) && p.until! - (p.told[threadOf(key)] ?? -Infinity) > 30 * 60_000) {
    setTold(p, key, p.until!, now)
    const at = (o.time ?? clockTime)(p.until!, now)
    o.notice(t, limit.kind === 'overloaded' ? `Paused: Claude is overloaded. I'll try again at ${at}.` : `Paused by the usage limit until ${at}. I'll pick this up then.`)
  }
  return true
}

function cleared(p: Pause, key: string, tasks: Task[], now: number, done: boolean) {
  const { o } = p
  o.settle?.(tasks, done)
  if (p.probing === threadOf(key) && p.until !== undefined) { p.probing = undefined; o.log('the limit lifted early'); void lift(p) }
  if (key === threadOf(key) && key in p.told) setTold(p, key, undefined, now)
  for (const t of tasks) { const s = sourceOf(t); if (s && p.open.delete(s)) o.store.handled(s) }
}

function limited(p: Pause, key: string, tasks: Task[], limit: Limit, now: number) {
  const { o } = p
  if (p.probing === threadOf(key)) p.probing = undefined
  p.counts.limitHits++
  p.kind = limit.kind
  const resets = limit.until && limit.until > now ? limit.until : now + RETRY[limit.kind]
  p.until = Math.max(p.until ?? 0, resets)
  o.log(`${limit.kind === 'overloaded' ? 'overload' : 'usage limit'} hit in ${key}: paused until ${new Date(p.until).toISOString()}, ${tasks.length} task${tasks.length === 1 ? '' : 's'} held`)
  const all = [...tasks, ...o.end(key) ?? []]
  o.event?.(`${limit.kind}${limit.window ? ` window=${limit.window}` : ''} wait_s=${Math.round((resets - now) / 1000)} held=${all.length}`)
  o.settle?.(all, false)
  for (const t of all) if (!keep(p, key, t, limit, now) && !t.handoff) o.log('cannot hold a task with no inbox message', logKey(key), t.meta.place)
}

async function lift(p: Pause) {
  const { o } = p
  p.until = undefined
  const rows = o.store.held()
  o.log(`the pause is over: replaying ${rows.length} held message${rows.length === 1 ? '' : 's'} and ${p.owed.size} scheduled run${p.owed.size === 1 ? '' : 's'}`)
  const lost: string[] = []
  for (const r of rows) {
    o.store.release(r.source)
    p.open.delete(r.source)
    try { await o.replay(r); p.counts.replays++ } catch (e) {
      p.counts.replayFailures++
      o.log('replay failed', r.source, e)
      o.store.handled(r.source)
      lost.push(r.source)
    }
  }
  if (lost.length) o.tellOwner(ownerLines.limitLost(lost))
  for (const [job, { key, task }] of [...p.owed]) { p.owed.delete(job); p.counts.replays++; o.redeliver(key, task) }
}
