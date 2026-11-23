import type { Saved } from './store.ts'

type ChannelWatch = { channel: string; match?: string; bots: boolean }
export type ChannelPost = { channel: string; ts: string; user?: string; app_id?: string; bot?: boolean; text: string; quoted: string }

const DEFAULT_MAX_POSTS = 20
const DEFAULT_SEEN_MAX = 500

export async function pageAll<T>(page: (cursor?: string) => Promise<{ items: T[]; next?: string }>, max: number): Promise<{ items: T[]; truncated: boolean }> {
  const items: T[] = []
  let cursor: string | undefined
  do {
    const r = await page(cursor)
    items.push(...r.items)
    cursor = r.next
    if (items.length >= max && cursor) return { items: items.slice(0, max), truncated: true }
  } while (cursor)
  return { items, truncated: false }
}

const after = (a: string, b: string) => { const [as = '0', af = ''] = a.split('.'), [bs = '0', bf = ''] = b.split('.'); return as.length - bs.length || (as > bs ? 1 : as < bs ? -1 : af.padEnd(9, '0') > bf.padEnd(9, '0') ? 1 : af.padEnd(9, '0') < bf.padEnd(9, '0') ? -1 : 0) }

export type ChannelHistory = {
  fetch(channel: string, oldest: string): Promise<{ posts: ChannelPost[]; truncated: boolean }>
  newest(channel: string): Promise<string | undefined>
}
type History = (a: { channel: string; oldest?: string; cursor?: string; limit: number }) => Promise<{ messages?: unknown[]; response_metadata?: { next_cursor?: string } }>

export function channelHistory(history: History, max: number, toPosts: (m: unknown, channel: string) => ChannelPost[]): ChannelHistory {
  return {
    async fetch(channel, oldest) {
      const { items } = await pageAll(async cursor => {
        const res = await history({ channel, oldest, limit: 200, ...(cursor && { cursor }) })
        return { items: res.messages ?? [], next: res.response_metadata?.next_cursor || undefined }
      }, Infinity)
      const posts = items.flatMap(m => toPosts(m, channel)).sort((x, y) => after(x.ts, y.ts))
      return { posts: posts.slice(0, max), truncated: posts.length > max }
    },
    async newest(channel) {
      const res = await history({ channel, limit: 1 })
      return (res.messages?.[0] as { ts?: string } | undefined)?.ts
    },
  }
}

type Seen = { ts: string[]; cursor?: string }
type CatchUpResult = { channel: string; truncated: boolean; error?: unknown }

type Watches = {
  saved: Saved; maxPosts: () => number; seenMax: () => number
  patterns: Map<string, { source: string; re: RegExp }>; closed: Set<string>; gap: number; posts: Map<string, string[]>
}

const seen = (w: Watches): Record<string, Seen> => (w.saved.load('channel-seen') as Record<string, Seen> | undefined) ?? {}
const change = (w: Watches, channel: string, f: (s: Seen) => Seen) => w.saved.save('channel-seen', { ...seen(w), [channel]: f(seen(w)[channel] ?? { ts: [] }) })
const watches = (w: Watches): Record<string, ChannelWatch> => (w.saved.load('channel-watches') as Record<string, ChannelWatch> | undefined) ?? {}

function compile(w: Watches, id: string, source: string) {
  const hit = w.patterns.get(id)
  if (hit?.source === source) return hit.re
  let re: RegExp
  try { re = new RegExp(source) } catch { throw new Error(`match is not a valid regex: ${source}`) }
  w.patterns.set(id, { source, re })
  return re
}

function heard(w: Watches, post: ChannelPost): string[] {
  const mark = seen(w)[post.channel]
  if (!mark || mark.ts.includes(post.ts)) return []
  change(w, post.channel, s => ({ ...s, ts: [...s.ts, post.ts].slice(-Math.max(1, w.seenMax())),
    ...(w.closed.has(post.channel) && s.cursor !== undefined && after(post.ts, s.cursor) > 0 && { cursor: post.ts }) }))
  const hit = Object.entries(watches(w)).filter(([id, x]) =>
    x.channel === post.channel && (x.bots || !(post.bot || post.app_id)) && (x.match === undefined || compile(w, id, x.match).test(post.text))).map(([id]) => id)
  for (const id of hit) w.posts.set(id, [...(w.posts.get(id) ?? []), post.quoted].slice(-Math.max(1, w.maxPosts())))
  return hit
}

async function catchUpChannel(w: Watches, history: ChannelHistory, channel: string, started: number): Promise<CatchUpResult> {
  const cursor = seen(w)[channel]!.cursor
  if (cursor === undefined) {
    const newest = await history.newest(channel)
    change(w, channel, s => ({ ...s, cursor: newest ?? '0' }))
    if (w.gap === started) w.closed.add(channel)
    return { channel, truncated: false }
  }
  const { posts: got, truncated } = await history.fetch(channel, cursor)
  const ordered = got.sort((a, b) => after(a.ts, b.ts))
  for (const p of ordered) heard(w, p)
  const top = ordered.at(-1)?.ts
  if (top && after(top, cursor) > 0) change(w, channel, s => ({ ...s, cursor: top }))
  if (!truncated && w.gap === started) w.closed.add(channel)
  return { channel, truncated }
}

async function catchUp(w: Watches, history: ChannelHistory): Promise<CatchUpResult[]> {
  const out: CatchUpResult[] = []
  const started = w.gap
  for (const channel of Object.keys(seen(w))) {
    if (!Object.values(watches(w)).some(x => x.channel === channel)) continue
    try { out.push(await catchUpChannel(w, history, channel, started)) } catch (error) { out.push({ channel, truncated: false, error }) }
  }
  return out
}

export function channelWatches(saved: Saved, o: { maxPosts?: () => number; seenMax?: () => number } = {}) {
  const w: Watches = { saved, maxPosts: o.maxPosts ?? (() => DEFAULT_MAX_POSTS), seenMax: o.seenMax ?? (() => DEFAULT_SEEN_MAX), patterns: new Map(), closed: new Set(), gap: 0, posts: new Map() }
  return {
    set: (jobId: string, watch: ChannelWatch) => {
      if (watch.match !== undefined) compile(w, jobId, watch.match)
      saved.save('channel-watches', { ...watches(w), [jobId]: watch })
      if (!seen(w)[watch.channel]) change(w, watch.channel, s => s)
    },
    remove: (jobId: string) => {
      const { [jobId]: _, ...rest } = watches(w)
      saved.save('channel-watches', rest)
      w.patterns.delete(jobId)
      w.posts.delete(jobId)
    },
    list: () => watches(w),
    gapOpened: () => { w.gap++; w.closed.clear() },
    heard: (post: ChannelPost) => heard(w, post),
    catchUp: (history: ChannelHistory) => catchUp(w, history),
    take: (jobId: string): string[] => {
      const got = w.posts.get(jobId) ?? []
      w.posts.delete(jobId)
      return got
    },
  }
}
