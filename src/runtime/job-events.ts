import { safePattern, type Trigger } from '../core/tripwire.ts'
import type { Schedule } from '../core/cron.ts'
import { channelWatches, type ChannelHistory, type ChannelPost } from './channel-watch.ts'
import type { Saved } from './store.ts'

type WakeOptions = { done?: () => void; ran?: (s: Schedule, n: number) => void; failed?: (s: Schedule) => void }

type Options = {
  saved: Saved
  schedules: () => Schedule[]
  wake: (id: string, quotes: string[], x?: WakeOptions) => void
  track: (who: string, detail: string) => void
  ping: (key: string, text: string) => void
  cfg: () => { patternMax: number; maxPosts: number; seenMax: number }
}
type Jobs = { o: Options; watches: ReturnType<typeof channelWatches>; queue: Promise<unknown>; failing: Set<string>; ran: (s: Schedule, n: number) => void; failed: (s: Schedule) => void }

const wake = (j: Jobs, id: string, quotes: string[], done?: () => void) => j.o.wake(id, quotes, { ran: j.ran, failed: j.failed, ...(done && { done }) })
const held = (o: Options) => (o.saved.load('job-held') as Record<string, string[]> | undefined) ?? {}
const setHeld = (o: Options, id: string, quotes: string[]) => { const { [id]: _, ...rest } = held(o); o.saved.save('job-held', quotes.length ? { ...rest, [id]: quotes } : rest) }
const release = (o: Options, id: string, quotes: string[]) => () => { const left = [...held(o)[id] ?? []]; for (const q of quotes) { const i = left.indexOf(q); if (i >= 0) left.splice(i, 1) } setHeld(o, id, left) }
function holdAndWake(j: Jobs, id: string, quotes: string[]) {
  if (!quotes.length) return
  setHeld(j.o, id, [...held(j.o)[id] ?? [], ...quotes].slice(-Math.max(1, j.o.cfg().maxPosts)))
  wake(j, id, quotes, release(j.o, id, quotes))
}

function refuse(o: Options, t?: Trigger): string | undefined {
  if (t?.kind !== 'channel' || t.match === undefined) return undefined
  const why = safePattern(t.match, o.cfg().patternMax)
  return why && `match refused: ${why}`
}
const started = (j: Jobs, id: string, t?: Trigger) => { if (t?.kind === 'channel') j.watches.set(id, { channel: t.channel, bots: t.bots, ...(t.match !== undefined && { match: t.match }) }) }

function rebuild(j: Jobs) {
  const { o, watches } = j, all = o.schedules()
  for (const id of Object.keys(watches.list())) if (!all.some(s => s.id === id)) watches.remove(id)
  for (const s of all) started(j, s.id, s.trigger)
  for (const [id, quotes] of Object.entries(held(o))) { if (all.some(s => s.id === id)) wake(j, id, quotes, release(o, id, quotes)); else setHeld(o, id, []) }
}

function channelPost(j: Jobs, post: ChannelPost) {
  for (const id of j.watches.heard(post)) {
    const s = j.o.schedules().find(x => x.id === id)
    if (!s) { j.watches.remove(id); continue }
    j.o.track(s.key, `match job=${id} channel=${post.channel} ts=${post.ts}`)
    holdAndWake(j, id, j.watches.take(id))
  }
}

function failed(j: Jobs, channel: string) {
  if (j.failing.has(channel)) return
  j.failing.add(channel)
  for (const s of j.o.schedules()) if (s.trigger?.kind === 'channel' && s.trigger.channel === channel) {
    j.o.ping(s.key, `I could not read channel ${channel} after Slack reconnected, so job ${s.id} may have missed posts. I keep trying, and say nothing more until it works.`)
    j.o.track(s.key, `ping job=${s.id} fails=1`)
  }
}

async function pass(j: Jobs, history: ChannelHistory) {
  const read = new Map<string, number>()
  const counted: ChannelHistory = { newest: c => history.newest(c), fetch: async (c, oldest) => {
    const r = await history.fetch(c, oldest)
    read.set(c, (read.get(c) ?? 0) + r.posts.length)
    for (const p of r.posts) channelPost(j, p)
    return r
  } }
  const results = await j.watches.catchUp(counted)
  for (const r of results) {
    j.o.track('hub', `catchup channel=${r.channel} read=${read.get(r.channel) ?? 0} capped=${r.truncated}${r.error ? ' failed=1' : ''}`)
    if (!r.error) j.failing.delete(r.channel)
    else failed(j, r.channel)
  }
  return results.some(r => r.truncated)
}

function channelCatchUp(j: Jobs, history: ChannelHistory): Promise<void> {
  const run = j.queue.then(async () => { while (await pass(j, history)); })
  j.queue = run.catch(() => {})
  return run
}

export function jobEvents(o: Options) {
  const watches = channelWatches(o.saved, { maxPosts: () => o.cfg().maxPosts, seenMax: () => o.cfg().seenMax })
  const j: Jobs = { o, watches, queue: Promise.resolve(), failing: new Set(),
    ran: (s, n) => o.track(s.key, `wake job=${s.id} reason=${s.trigger?.kind ?? 'event'} n=${n}`),
    failed: s => o.track(s.key, `wake job=${s.id} failed=1`) }
  return {
    refuse: (t?: Trigger) => refuse(o, t),
    started: (id: string, t?: Trigger) => started(j, id, t),
    stopped: (id: string) => { watches.remove(id); setHeld(o, id, []) },
    rebuild: () => rebuild(j),
    channelPost: (post: ChannelPost) => channelPost(j, post),
    channelCatchUp: (history: ChannelHistory) => channelCatchUp(j, history),
    channelGap: watches.gapOpened,
    wake: (id: string, quotes: string[], done?: () => void) => wake(j, id, quotes, done),
    watching: () => Object.keys(watches.list()),
  }
}
