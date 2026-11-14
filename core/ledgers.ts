// Reading the ledgers (rows in kage.db, runtime/ledger.ts, read back as TSV): open questions, Kage's own posts, costs.

// One ledger row. Cells never hold a tab or newline, so a row is always one line.
export const tsvRow = (cells: (string | undefined)[]) => cells.map(c => (c ?? '').replace(/[\t\r\n]+/g, ' ')).join('\t') + '\n'

// The waiting ledger (runtime/ledger.ts; every thread's pane writes it): when, open|answered, thread, link, what.
// A question stays open until its thread gets a new task.
// ponytail: any new task closes it, even from someone else in the thread; match the asker if that bites.
export function openWaiting(tsv: string): { when: string; thread: string; link: string; what: string }[] {
  const open = new Map<string, { when: string; thread: string; link: string; what: string }[]>()
  for (const line of tsv.split('\n')) {
    const [when = '', status, thread = '', link = '', what = ''] = line.split('\t')
    if (status === 'answered') open.delete(thread)
    else if (status === 'open') open.set(thread, [...(open.get(thread) ?? []), { when, thread, link, what }])
  }
  return [...open.values()].flat()
}

// The posted ledger: when, channel, ts, bot|owner|people|deleted|card, the session key that posted (a card row holds its request id instead) (rows before 11-06 have none). The token a message went out
// with is the one that may change it; anything not on the list is someone else's.
export function postedBy(tsv: string, channel: string, ts: string): 'bot' | 'owner' | undefined {
  let by: string | undefined
  for (const line of tsv.split('\n')) {
    const [, c, t, who] = line.split('\t')
    if (c === channel && t === ts) by = who
  }
  return by === 'bot' || by === 'owner' ? by : undefined
}

// The request id of the approval card the hub posted at this message. Only the hub's own 'card' row
// counts: a reply that copies a card's words is a 'bot' row, so it can never approve a real request.
export function cardAt(tsv: string, channel: string, ts: string): string | undefined {
  for (const line of tsv.split('\n')) {
    const [, c, t, kind, id] = line.split('\t')
    if (c === channel && t === ts && kind === 'card') return id
  }
}

// The thread ("C1:1.1") whose task posted this message in the owner's DM (a private ask), so the
// owner's answer under it goes back there. None for the DM's own threads.
// ponytail: the posted ledger logs the thread, not the lane, so a side lane's ask is answered in the main lane.
export function askedFrom(tsv: string, dm: string, ts: string): string | undefined {
  let key: string | undefined
  for (const line of tsv.split('\n')) {
    const [, c, t, , k] = line.split('\t')
    if (c === dm && t === ts) key = k
  }
  // Only a Slack thread can take the answer: an email, WhatsApp or call ask stays a DM task.
  return key && /^(?:[\w-]+\/)?[A-Z0-9]+:\d+\.\d+(?:#.+)?$/.test(key) && !key.includes(`${dm}:`) ? key : undefined
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

// The costs ledger: when, session key, this turn's USD, the session's running total. The
// Agent SDK reports a running total per Claude conversation (resumes carry it on), never a turn's
// own cost, so a turn is what the total grew by. A total that went down started over (/clear).
// ponytail: a /clear followed by a turn dearer than the old total reads as growth; the total alone can't tell.
// A crash result reports zeros: undefined, so the caller logs nothing and keeps the old total.
// A resumed conversation's first total carries its whole life, so with no row yet it is a baseline (0).
// ponytail: that first resumed turn reads as free, one turn per thread; per-turn usage would fix it.
export const turnCost = (last: number | undefined, total: number, resumed = false) =>
  !(total > 0) ? undefined : last === undefined ? (resumed ? 0 : total) : total < last ? total : Math.round((total - last) * 1e6) / 1e6
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

// The daily note's line on kagelet grants (runtime/kagelets.ts) made with no card from `from` up to `to`: Kage's
// read grants and the owner's standing approvals. The grants ledger: when, kagelet, status, why, tools.
export function grantsLine(tsv: string, from: number, to: number): string | undefined {
  const by = { read: 'read', standing: 'your standing yes' } as Record<string, string>
  const got = tsv.split('\n').map(l => l.split('\t')).filter(([at = '', , status = '']) => by[status] && Date.parse(at) >= from && Date.parse(at) < to)
    .map(([, name, status, , tools]) => `${name} got ${tools} (${by[status!]})`)
  return got.length ? `*Kagelet grants with no card*: ${got.join('; ')}. To end a write tool's standing yes: v in kage top, or ask me. A read grant ends when the kagelet is saved without it or removed.` : undefined
}
