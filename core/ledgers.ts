// Append-only ledgers on disk: rows, open questions, Kage's own posts.

// One ledger row. Cells never hold a tab or newline, so a row is always one line.
export const tsvRow = (cells: (string | undefined)[]) => cells.map(c => (c ?? '').replace(/[\t\r\n]+/g, ' ')).join('\t') + '\n'

// waiting.tsv is append-only (every thread's pane writes it): when, open|answered, thread, link, what.
// A question stays open until its thread gets a new task.
// ponytail: any new task closes it, even from someone else in the thread; match the asker if that bites.
export function openWaiting(tsv: string): { when: string; link: string; what: string }[] {
  const open = new Map<string, { when: string; link: string; what: string }[]>()
  for (const line of tsv.split('\n')) {
    const [when = '', status, thread = '', link = '', what = ''] = line.split('\t')
    if (status === 'answered') open.delete(thread)
    else if (status === 'open') open.set(thread, [...(open.get(thread) ?? []), { when, link, what }])
  }
  return [...open.values()].flat()
}

// posted.tsv is append-only: when, channel, ts, bot|owner|deleted, the session key that posted (rows before 11-06 have none). The token a message went out
// with is the one that may change it; anything not on the list is someone else's.
export function postedBy(tsv: string, channel: string, ts: string): 'bot' | 'owner' | undefined {
  let by: string | undefined
  for (const line of tsv.split('\n')) {
    const [, c, t, who] = line.split('\t')
    if (c === channel && t === ts) by = who
  }
  return by === 'bot' || by === 'owner' ? by : undefined
}

// The daily note to the owner: questions that have waited on them for ageMs or more.
export const staleWaiting = (tsv: string, now: number, ageMs: number) =>
  openWaiting(tsv).filter(i => now - Date.parse(i.when) >= ageMs)

// Due once a UTC day from 05:00 UTC: returns today's date to record as sent.
export function dailyDue(now: number, lastSent: string | undefined): string | undefined {
  const t = new Date(now)
  const today = t.toISOString().slice(0, 10)
  return t.getUTCHours() >= 5 && lastSent !== today ? today : undefined
}

// costs.tsv is append-only: when, session key, this turn's USD, the session's running total. The
// Agent SDK reports a running total per Claude conversation (resumes carry it on), never a turn's
// own cost, so a turn is what the total grew by. A total that went down started over (/clear).
// ponytail: a /clear followed by a turn dearer than the old total reads as growth; the total alone can't tell.
// A crash result reports zeros: undefined, so the caller logs nothing and keeps the old total.
export const turnCost = (last: number | undefined, total: number) =>
  !(total > 0) ? undefined : last === undefined || total < last ? total : Math.round((total - last) * 1e6) / 1e6
const costRows = (tsv: string) => tsv.split('\n').filter(Boolean).map(l => {
  const [when = '', key = '', usd = '', total = ''] = l.split('\t')
  return { at: Date.parse(when), key, usd: Number(usd), total: Number(total) }
}).filter(r => r.key && Number.isFinite(r.usd))
export const lastTotals = (tsv: string) => new Map(costRows(tsv).map(r => [r.key, r.total]))
export function spendSince(tsv: string, since: number): { key: string; usd: number; turns: number }[] {
  const by = new Map<string, { key: string; usd: number; turns: number }>()
  for (const r of costRows(tsv)) {
    if (!(r.at >= since)) continue
    const k = by.get(r.key) ?? by.set(r.key, { key: r.key, usd: 0, turns: 0 }).get(r.key)!
    k.usd = Math.round((k.usd + r.usd) * 1e6) / 1e6
    k.turns++
  }
  return [...by.values()].sort((a, b) => b.usd - a.usd)
}
