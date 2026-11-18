import type { Saved } from './store.ts'

export type ChannelWatch = { channel: string; match?: string; bots: boolean }
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
export type CatchUpResult = { channel: string; truncated: boolean; error?: unknown }

export function channelWatches(saved: Saved, o: { maxPosts?: () => number; seenMax?: () => number } = {}) {
  const maxPosts = o.maxPosts ?? (() => DEFAULT_MAX_POSTS)
  const seenMax = o.seenMax ?? (() => DEFAULT_SEEN_MAX)
  const seen = (): Record<string, Seen> => (saved.load('channel-seen') as Record<string, Seen> | undefined) ?? {}
  const change = (channel: string, f: (s: Seen) => Seen) => saved.save('channel-seen', { ...seen(), [channel]: f(seen()[channel] ?? { ts: [] }) })
  const watches = (): Record<string, ChannelWatch> => (saved.load('channel-watches') as Record<string, ChannelWatch> | undefined) ?? {}
  const patterns = new Map<string, { source: string; re: RegExp }>()
  const compile = (id: string, source: string) => {
    const hit = patterns.get(id)
    if (hit?.source === source) return hit.re
    let re: RegExp
    try { re = new RegExp(source) } catch { throw new Error(`match is not a valid regex: ${source}`) }
    patterns.set(id, { source, re })
    return re
  }
  const closed = new Set<string>()
  let gap = 0
  const posts = new Map<string, string[]>()
  const heard = (post: ChannelPost): string[] => {
    const mark = seen()[post.channel]
    if (!mark || mark.ts.includes(post.ts)) return []
    change(post.channel, s => ({ ...s, ts: [...s.ts, post.ts].slice(-Math.max(1, seenMax())),
      ...(closed.has(post.channel) && s.cursor !== undefined && after(post.ts, s.cursor) > 0 && { cursor: post.ts }) }))
    const hit = Object.entries(watches()).filter(([id, w]) =>
      w.channel === post.channel && (w.bots || !(post.bot || post.app_id)) && (w.match === undefined || compile(id, w.match).test(post.text))).map(([id]) => id)
    for (const id of hit) posts.set(id, [...(posts.get(id) ?? []), post.quoted].slice(-Math.max(1, maxPosts())))
    return hit
  }
  const catchUp = async (history: ChannelHistory): Promise<CatchUpResult[]> => {
    const out: CatchUpResult[] = []
    const started = gap
    for (const channel of Object.keys(seen())) {
      if (!Object.values(watches()).some(w => w.channel === channel)) continue
      try {
        const cursor = seen()[channel]!.cursor
        if (cursor === undefined) {
          const newest = await history.newest(channel)
          change(channel, s => ({ ...s, cursor: newest ?? '0' }))
          if (gap === started) closed.add(channel)
          out.push({ channel, truncated: false })
          continue
        }
        const { posts: got, truncated } = await history.fetch(channel, cursor)
        const ordered = got.sort((a, b) => after(a.ts, b.ts))
        for (const p of ordered) heard(p)
        const top = ordered.at(-1)?.ts
        if (top && after(top, cursor) > 0) change(channel, s => ({ ...s, cursor: top }))
        if (!truncated && gap === started) closed.add(channel)
        out.push({ channel, truncated })
      } catch (error) { out.push({ channel, truncated: false, error }) }
    }
    return out
  }
  return {
    set: (jobId: string, watch: ChannelWatch) => {
      if (watch.match !== undefined) compile(jobId, watch.match)
      saved.save('channel-watches', { ...watches(), [jobId]: watch })
      if (!seen()[watch.channel]) change(watch.channel, s => s)
    },
    remove: (jobId: string) => {
      const { [jobId]: _, ...rest } = watches()
      saved.save('channel-watches', rest)
      patterns.delete(jobId)
      posts.delete(jobId)
    },
    list: watches,
    gapOpened: () => { gap++; closed.clear() },
    heard,
    catchUp,
    take: (jobId: string): string[] => {
      const got = posts.get(jobId) ?? []
      posts.delete(jobId)
      return got
    },
  }
}
