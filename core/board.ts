// What `kage top` shows: one row per thread, what state it is in, and in what order to look at
// them. Pure: the console feeds it the hub's live board, the store and the transcripts' times.
import { CRON_RECURRING_TTL, cronJobsFromTranscript, nextRun, type Schedule } from './cron.ts'

// What the hub reports (Dispatcher.status): live sessions, threads waiting for a slot or held by a terminal.
export type Live = {
  live: { key: string; state: 'busy' | 'asking' | 'starting' | 'watching' | 'quiet'; quietMs: number }[]
  waiting: string[]
  held: string[]
  max: number
}
export type Known = { key: string; place: string; lastSeen: number; connector: string }
export type State = 'asking' | 'working' | 'starting' | 'watching' | 'queued' | 'held' | 'quiet' | 'closed'
export type Row = { key: string; place: string; connector: string; state: State; label: string; ageMs: number; next?: number }

const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR
// Look-first order: a session that asks you is stuck until you answer.
const ORDER: State[] = ['asking', 'working', 'starting', 'watching', 'queued', 'held', 'quiet', 'closed']
const LABEL: Record<State, string> = { asking: 'asks you', working: 'working', starting: 'starting', watching: 'watching', queued: 'queued', held: 'in terminal', quiet: 'quiet', closed: 'closed' }
const FROM_HUB = { busy: 'working', asking: 'asking', starting: 'starting', watching: 'watching', quiet: 'quiet' } as const

// `live` undefined: the hub is not running, so no thread can be called alive. activity: when a
// thread's transcript last changed.
export function boardRows(known: Known[], live: Live | undefined, activity: Map<string, number>, next: Map<string, number>, now: number): { rows: Row[] } {
  const hub = new Map<string, { state: State; quietMs?: number }>()
  for (const l of live?.live ?? []) hub.set(l.key, { state: FROM_HUB[l.state], quietMs: l.quietMs })
  for (const k of live?.waiting ?? []) hub.set(k, { state: 'queued' })
  for (const k of live?.held ?? []) hub.set(k, { state: 'held' })
  const rows: Row[] = []
  for (const k of known) {
    const h = hub.get(k.key)
    const state = h?.state ?? 'closed'
    const ageMs = Math.max(0, h?.quietMs ?? now - Math.max(k.lastSeen, activity.get(k.key) ?? 0))
    const n = next.get(k.key)
    rows.push({ key: k.key, place: k.place, connector: k.connector, state, label: LABEL[state], ageMs, ...(n !== undefined && { next: n }) })
  }
  rows.sort((a, b) => ORDER.indexOf(a.state) - ORDER.indexOf(b.state) || a.ageMs - b.ageMs)
  return { rows }
}

export function ago(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  return s < 86400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`
}

const hhmm = (d: Date) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
// Local time, as cron reads it: a clock time for today, a weekday and time after that.
export function whenLabel(t: number | undefined, now: number): string {
  if (t === undefined) return '-'
  const d = new Date(t)
  return d.toDateString() === new Date(now).toDateString() ? hhmm(d) : `${DAYS[d.getDay()]} ${hhmm(d)}`
}

// The timed checks (CronCreate) a session's transcript still holds, and when the soonest runs. A pane
// holds them only while its process lives, which the hub already knows when it says "watching"; this
// only reads when. ponytail: a check from an earlier process of the same thread could still show,
// since the console cannot see the process start.
export function watchingNext(lines: string[], now: number): number | undefined {
  const jobs = cronJobsFromTranscript(lines, now - CRON_RECURRING_TTL).filter(j => j.recurring || now - j.created < DAY)
  let best: number | undefined
  for (const j of jobs) {
    let at: Date | undefined
    try { at = nextRun(j.cron, new Date(now), 7 * DAY) } catch { continue }
    if (at && (best === undefined || at.getTime() < best)) best = at.getTime()
  }
  return best
}

// ponytail: looks 7 days ahead, so a monthly job shows no next run.
export function nextRuns(all: Schedule[], now: number): Map<string, number> {
  const out = new Map<string, number>()
  for (const s of all) {
    if (!s.recurring && s.lastFired) continue
    let at: Date | undefined
    try { at = nextRun(s.cron, new Date(now), 7 * DAY) } catch { continue }
    if (!at || (s.ends && at.getTime() >= s.ends)) continue
    if (at.getTime() < (out.get(s.key) ?? Infinity)) out.set(s.key, at.getTime())
  }
  return out
}
