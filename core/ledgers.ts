// Append-only ledgers on disk: rows, open questions, Kage's own posts.

// One ledger row. Cells never hold a tab or newline, so a row is always one line.
export const tsvRow = (cells: (string | undefined)[]) => cells.map(c => (c ?? '').replace(/[\t\r\n]+/g, ' ')).join('\t') + '\n'

// waiting.tsv is append-only (every thread's pane writes it): when, open|answered, thread, link, what.
// An offer stays open until its thread gets a new task.
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

// posted.tsv is append-only: when, channel, ts, bot|owner|deleted. The token a message went out
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

// Due once a UTC day from 05:00 UTC (10:30 IST): returns today's date to record as sent.
export function dailyDue(now: number, lastSent: string | undefined): string | undefined {
  const t = new Date(now)
  const today = t.toISOString().slice(0, 10)
  return t.getUTCHours() >= 5 && lastSent !== today ? today : undefined
}
