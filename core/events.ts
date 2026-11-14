// The event log (#94): one row per thing a kagelet or a Kage session did, for the dream and learning jobs.
// A row names what happened, never what was said: no message text, query rows or secrets. A run's text
// stays in its transcript, and the row keeps only the path.
export type EventKind = 'run.start' | 'run.end' | 'tool' | 'handoff' | 'grant' | 'refusal' | 'owner-note' | 'report' | 'cap-pause' | 'day-summary'
// who: the kagelet's name, or the session key. trace: one run. chain: one chain of runs (#93), '' outside one.
export type KageEvent = { at: string; kind: EventKind; who: string; trace: string; chain: string; detail: string; transcript: string }

// Kept 30 days, then each day folds into one day-summary row (runtime/ledger.ts pruneEvents).
export const EVENT_DAYS = 30

export const eventRow = (e: Omit<KageEvent, 'at' | 'chain' | 'transcript'> & Partial<Pick<KageEvent, 'chain' | 'transcript'>>): Omit<KageEvent, 'at'> =>
  ({ chain: '', transcript: '', ...e, detail: e.detail.replace(/\s+/g, ' ').trim().slice(0, 200) })

export const whoOf = (key: string) => key.split('#side-kagelet-')[1] ?? key

// What the dream job reads: one day's (UTC, YYYY-MM-DD) events, grouped by kagelet or session and chain.
export function dayEvents(events: KageEvent[], day: string): { who: string; chain: string; events: KageEvent[] }[] {
  const groups = new Map<string, { who: string; chain: string; events: KageEvent[] }>()
  for (const e of events.filter(e => e.at.startsWith(day)).sort((a, b) => a.at.localeCompare(b.at))) {
    const k = `${e.who}\t${e.chain}`
    if (!groups.has(k)) groups.set(k, { who: e.who, chain: e.chain, events: [] })
    groups.get(k)!.events.push(e)
  }
  return [...groups.values()].sort((a, b) => a.who.localeCompare(b.who) || a.chain.localeCompare(b.chain))
}
