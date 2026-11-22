import { log } from '../runtime/log.ts'
import { noticeFeeds, notices } from '../core/github-notices.ts'
import type { Saved } from '../runtime/store.ts'

const API = 'https://api.github.com'
const CURSOR = 'github-poll'
const OVERLAP_MS = 60_000
const MIN_WAIT_MS = 60_000
const TRIES = 3
const PAGES = 20
const next = (link: string | null) => /<([^>]+)>;\s*rel="next"/.exec(link ?? '')?.[1]

type Cursor = { since: string; modified?: string }

export function pollGithub(o: {
  token: string; login: string; saved: Saved
  feed: (type: string, body: string, source: string) => Promise<unknown>
  refused: () => void
  fetch?: typeof fetch
}) {
  const call = o.fetch ?? fetch
  const headers = { Authorization: `Bearer ${o.token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }
  const get = async (url: string) => {
    const r = await call(url, { headers })
    if (!r.ok) throw new Error(`GitHub answered ${r.status} on ${new URL(url).pathname}`)
    return r.json()
  }
  const tries = new Map<string, number>()
  let told = false
  return async function once(now: number): Promise<number> {
    const cursor = (o.saved.load(CURSOR) ?? { since: new Date(now).toISOString() }) as Cursor
    const since = Date.parse(cursor.since) - OVERLAP_MS
    const r = await call(`${API}/notifications?all=true&per_page=50&since=${new Date(since).toISOString()}`,
      { headers: { ...headers, ...cursor.modified && { 'If-Modified-Since': cursor.modified } } })
    const wait = Math.max(MIN_WAIT_MS, Number(r.headers.get('x-poll-interval')) * 1000 || 0)
    if (r.status === 401) { if (!told) o.refused(); told = true; return wait }
    told = false
    if (r.status === 304) return wait
    if (!r.ok) throw new Error(`GitHub answered ${r.status} on notifications`)
    const raw: unknown[] = await r.json()
    for (let page = r, n = 1, url = next(r.headers.get('link')); url && n < PAGES; n++, url = next(page.headers.get('link'))) {
      page = await call(url, { headers })
      if (!page.ok) throw new Error(`GitHub answered ${page.status} on notifications`)
      raw.push(...await page.json())
    }
    let done = cursor.since
    for (const n of notices(raw)) {
      const key = `${n.id} ${n.updated_at}`
      try {
        for (const f of await noticeFeeds(n, get, o.login, since)) await o.feed(f.type, JSON.stringify(f.payload), f.source)
      } catch (e) {
        const tried = (tries.get(key) ?? 0) + 1
        tries.set(key, tried)
        if (tried < TRIES) { o.saved.save(CURSOR, { since: done }); return wait }
        log(`github notification ${n.repository.full_name} skipped after ${TRIES} tries`, e)
      }
      tries.delete(key)
      if (n.updated_at > done) done = n.updated_at
    }
    const modified = r.headers.get('last-modified')
    o.saved.save(CURSOR, { since: done, ...modified && { modified } })
    return wait
  }
}
