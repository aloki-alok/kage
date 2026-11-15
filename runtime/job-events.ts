// Jobs that an event wakes (ADR 0015 rung 2): a post in a Slack channel, or a call to the job's webhook. This holds the
// rules between the Slack connector's hooks, the channel watches and the scheduler's wake. Every step writes one
// tripwire event row (ids and counts only, never a post's text) through `track`.
import { safePattern, type Trigger } from '../core/tripwire.ts'
import type { Schedule } from '../core/cron.ts'
import { channelWatches, type ChannelHistory, type ChannelPost } from './channel-watch.ts'
import type { Saved } from './store.ts'

export type WakeOptions = { done?: () => void; ran?: (s: Schedule, n: number) => void; failed?: (s: Schedule) => void }

export function jobEvents(o: {
  saved: Saved
  schedules: () => Schedule[]
  wake: (id: string, quotes: string[], x?: WakeOptions) => void
  track: (who: string, detail: string) => void
  ping: (key: string, text: string) => void   // into the job's thread as Kage, with no model
  cfg: () => { patternMax: number; maxPosts: number; seenMax: number }
}) {
  const watches = channelWatches(o.saved, { maxPosts: () => o.cfg().maxPosts, seenMax: () => o.cfg().seenMax })
  const jobOf = (id: string) => o.schedules().find(s => s.id === id)
  // Told to the scheduler with each wake: a shared function, so a burst writes one wake row per run.
  const onRun = (s: Schedule, n: number) => o.track(s.key, `wake job=${s.id} reason=${s.trigger?.kind ?? 'event'} n=${n}`)
  const onFail = (s: Schedule) => o.track(s.key, `wake job=${s.id} failed=1`)
  const wake = (id: string, quotes: string[], done?: () => void) => o.wake(id, quotes, { ran: onRun, failed: onFail, ...(done && { done }) })
  // Posts taken for a job wait here, with the job, until its run has them: a restart or a failed tick loses none.
  const held = () => (o.saved.load('job-held') as Record<string, string[]> | undefined) ?? {}
  const setHeld = (id: string, quotes: string[]) => { const { [id]: _, ...rest } = held(); o.saved.save('job-held', quotes.length ? { ...rest, [id]: quotes } : rest) }
  const release = (id: string, quotes: string[]) => () => { const left = [...held()[id] ?? []]; for (const q of quotes) { const i = left.indexOf(q); if (i >= 0) left.splice(i, 1) } setHeld(id, left) }
  const holdAndWake = (id: string, quotes: string[]) => {
    if (!quotes.length) return
    setHeld(id, [...held()[id] ?? [], ...quotes].slice(-Math.max(1, o.cfg().maxPosts)))
    wake(id, quotes, release(id, quotes))
  }

  const refuse = (t?: Trigger): string | undefined => {
    if (t?.kind !== 'channel' || t.match === undefined) return undefined
    const why = safePattern(t.match, o.cfg().patternMax)
    return why && `match refused: ${why}`
  }
  const started = (id: string, t?: Trigger) => { if (t?.kind === 'channel') watches.set(id, { channel: t.channel, bots: t.bots, ...(t.match !== undefined && { match: t.match }) }) }
  const stopped = (id: string) => { watches.remove(id); setHeld(id, []) }

  // At hub start: every watch from the stored triggers, then a gap, so the first catch-up runs. A saved watch whose schedule is gone goes.
  const rebuild = () => {
    const all = o.schedules()
    for (const id of Object.keys(watches.list())) if (!all.some(s => s.id === id)) watches.remove(id)
    for (const s of all) started(s.id, s.trigger)
    for (const [id, quotes] of Object.entries(held())) { if (all.some(s => s.id === id)) wake(id, quotes, release(id, quotes)); else setHeld(id, []) }   // posts taken before the restart
    watches.gapOpened()
  }

  const channelPost = (post: ChannelPost) => {
    for (const id of watches.heard(post)) {
      const s = jobOf(id)
      if (!s) { watches.remove(id); continue }   // unscheduled behind the watch's back
      o.track(s.key, `match job=${id} channel=${post.channel} ts=${post.ts}`)
      holdAndWake(id, watches.take(id))
    }
  }

  let queue: Promise<unknown> = Promise.resolve()   // one catch-up at a time: two reconnects never read the same window twice
  const failing = new Set<string>()
  const pass = async (history: ChannelHistory) => {
    const read = new Map<string, number>()
    const counted: ChannelHistory = { newest: c => history.newest(c), fetch: async (c, oldest) => {
      const r = await history.fetch(c, oldest)
      read.set(c, (read.get(c) ?? 0) + r.posts.length)
      for (const p of r.posts) channelPost(p)   // the posts wake their jobs here, oldest first; the watch's own pass then finds them seen
      return r
    } }
    const results = await watches.catchUp(counted)
    for (const r of results) {
      o.track('hub', `catchup channel=${r.channel} read=${read.get(r.channel) ?? 0} capped=${r.truncated}${r.error ? ' failed=1' : ''}`)
      if (!r.error) { failing.delete(r.channel); continue }
      if (failing.has(r.channel)) continue
      failing.add(r.channel)
      for (const s of o.schedules()) if (s.trigger?.kind === 'channel' && s.trigger.channel === r.channel) {
        o.ping(s.key, `I could not read channel ${r.channel} after Slack reconnected, so job ${s.id} may have missed posts. I keep trying, and say nothing more until it works.`)
        o.track(s.key, `ping job=${s.id} fails=1`)
      }
    }
    return results.some(r => r.truncated)
  }
  const channelCatchUp = (history: ChannelHistory): Promise<void> => {
    const run = queue.then(async () => { while (await pass(history)); })
    queue = run.catch(() => {})
    return run
  }

  return { refuse, started, stopped, rebuild, channelPost, channelCatchUp, channelGap: watches.gapOpened, wake, watching: () => Object.keys(watches.list()) }
}
