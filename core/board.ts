import { CRON_RECURRING_TTL, cronJobsFromTranscript, nextRun, type Schedule } from './cron.ts'

export type Live = {
  live: { key: string; state: 'busy' | 'asking' | 'starting' | 'watching' | 'quiet'; quietMs: number }[]
  waiting: string[]
  held: string[]
  max: number
  paused?: Pause
  limitCounts?: LimitCounts
}
export type LimitCounts = { limitHits: number; held: number; replays: number; replayFailures: number }
export const limitLine = (c?: LimitCounts) =>
  c?.limitHits ? `Usage limit since the hub started: ${c.limitHits} hit${c.limitHits === 1 ? '' : 's'}, ${c.held} held, ${c.replays} replayed, ${c.replayFailures} replay${c.replayFailures === 1 ? '' : 's'} failed.` : undefined
type Pause = { until: number; held: number; draining?: true }
export function clockTime(at: number, now: number): string {
  const d = new Date(at)
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
  return d.toDateString() === new Date(now).toDateString() ? time : `${d.toLocaleDateString('en-GB', { weekday: 'short' })} ${d.getDate()} ${d.toLocaleDateString('en-GB', { month: 'short' })} ${time}`
}
export const pauseLine = (p: Pause, now = Date.now()) => {
  const when = p.draining ? 'after it' : 'then'
  const held = p.held === 0 ? 'No message is held.' : p.held === 1 ? `1 message is held, and it runs ${when}.` : `${p.held} messages are held, and they run ${when}.`
  return p.draining ? `Stopping for a restart or a stop: new messages wait. ${held}` : `Paused by the usage limit until ${clockTime(p.until, now)}. ${held}`
}
type Known = { key: string; place: string; lastSeen: number; connector: string }
export type State = 'asking' | 'working' | 'starting' | 'watching' | 'queued' | 'held' | 'quiet' | 'closed'
export type Row = { key: string; place: string; connector: string; state: State; label: string; ageMs: number; next?: number }

const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR
const ORDER: State[] = ['asking', 'working', 'starting', 'watching', 'queued', 'held', 'quiet', 'closed']
const LABEL: Record<State, string> = { asking: 'asks you', working: 'working', starting: 'starting', watching: 'watching', queued: 'queued', held: 'in terminal', quiet: 'quiet', closed: 'closed' }
const FROM_HUB = { busy: 'working', asking: 'asking', starting: 'starting', watching: 'watching', quiet: 'quiet' } as const

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
export function whenLabel(t: number | undefined, now: number): string {
  if (t === undefined) return '-'
  const d = new Date(t)
  return d.toDateString() === new Date(now).toDateString() ? hhmm(d) : `${DAYS[d.getDay()]} ${hhmm(d)}`
}

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

export function stopLine(r: { ok: true; ending?: true; asking?: true; cut?: 'busy' | 'asking'; dropped: number } | { refused: 'closed' }, jobs: string[], lanes = 0) {
  const n = jobs.length
  const kept = !n ? '' : ` ${n === 1 ? 'Its schedule keeps' : `Its ${n} schedules keep`} running: ${jobs.join('; ')}.`
  if ('refused' in r) return `No session runs in this thread.${kept}`
  const what = r.asking ? 'It waits on an approval, so it stops once that is answered. stop now cuts it.'
    : r.ending ? 'Stopping after the current turn.'
    : r.cut === 'busy' ? 'Stopped now: the turn in progress was cut.'
    : r.cut === 'asking' ? 'Stopped now: the approval it waited on was dropped.' : 'Stopped.'
  const let_go = !r.dropped ? '' : r.dropped === 1 ? ' 1 waiting message was let go.' : ` ${r.dropped} waiting messages were let go.`
  const side = !lanes ? '' : lanes === 1 ? ' Its side lane stops too.' : ` Its ${lanes} side lanes stop too.`
  return `${what}${let_go}${side}${kept} The next tag starts it again.`
}

export function statusSummary(f: { upSec?: number; boots24h: number; schedules: number; spentToday: number; turnsToday: number }): string[] {
  const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`
  return [[
    f.upSec === undefined ? 'hub up: unknown' : `hub up ${ago(f.upSec * 1000)}`,
    `${plural(f.boots24h, 'start')} in 24 h${f.boots24h > 10 ? ' (kage doctor says why)' : ''}`,
    f.schedules ? plural(f.schedules, 'schedule') : 'no schedules',
    f.turnsToday ? `$${f.spentToday.toFixed(2)} today over ${plural(f.turnsToday, 'turn')}` : 'nothing spent today',
  ].join(' · '), 'More: kage top (live, with controls), kage logs, kage cost 7, kage doctor']
}
