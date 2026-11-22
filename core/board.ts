import { startsLine, type Starts } from './boots.ts'
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
type Known = { key: string; place: string; lastSeen: number; connector: string; topic?: string }
export type State = 'asking' | 'working' | 'starting' | 'watching' | 'queued' | 'held' | 'quiet' | 'closed'
export type Row = { key: string; place: string; connector: string; state: State; label: string; ageMs: number; next?: number; topic?: string }
export const FOLDED = '+ended'

const ASKER = /^(Task from [^:\n]{1,60}|Teammate task \([^)\n]{0,120}\)|Scheduled check[^:\n]{0,60}|[A-Z][^:\n]{0,40} task[^:\n]{0,60}):\s*/
const PREAMBLE = /^(Scheduled run of job|Tripwire of job|This job started a new session|Job \w+ woke)\b|^(Before|After|Context):|^<\//
export function topicOf(firstAsk: string): string | undefined {
  const body = firstAsk.replace(/^<channel[^>]*>\s*/, '').split('\n').map(l => l.trim()).find(l => l && !l.startsWith('>') && !PREAMBLE.test(l))
  const words = body?.replace(ASKER, '').replace(/<@[A-Z0-9]+>/g, '').split(/\s+/).filter(Boolean).slice(0, 6)
  return words?.length ? words.join(' ') : undefined
}

const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR
const ORDER: State[] = ['asking', 'working', 'starting', 'watching', 'queued', 'held', 'quiet', 'closed']
const LABEL: Record<State, string> = { asking: 'asks you', working: 'working', starting: 'starting', watching: 'watching', queued: 'queued', held: 'in terminal', quiet: 'quiet', closed: 'closed' }
const FROM_HUB = { busy: 'working', asking: 'asking', starting: 'starting', watching: 'watching', quiet: 'quiet' } as const

export function boardRows(known: Known[], live: Live | undefined, activity: Map<string, number>, next: Map<string, number>, now: number, showEnded = false): { rows: Row[] } {
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
    rows.push({ key: k.key, place: k.place, connector: k.connector, state, label: LABEL[state], ageMs, ...(n !== undefined && { next: n }), ...(k.topic && { topic: k.topic }) })
  }
  rows.sort((a, b) => ORDER.indexOf(a.state) - ORDER.indexOf(b.state) || a.ageMs - b.ageMs)
  const old = rows.filter(r => r.state === 'closed' && r.ageMs > DAY)
  if (showEnded || !old.length) return { rows }
  const fold: Row = { key: FOLDED, place: `+${old.length} ended earlier`, connector: '', state: 'closed', label: '', ageMs: old[0]!.ageMs }
  return { rows: [...rows.filter(r => !old.includes(r)), fold] }
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

const UNIT: Record<string, string> = { s: 'second', m: 'minute', h: 'hour', d: 'day' }
const spoken = (short: string) => { const n = Number(short.slice(0, -1)); return `${n} ${UNIT[short.slice(-1)]}${n === 1 ? '' : 's'}` }

export function statusSummary(f: { version?: string; upSec?: number; starts: Starts; schedules: number; spentToday: number; turnsToday: number }): { says: string; warn?: string } {
  const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`
  const spent = f.turnsToday ? `spent $${f.spentToday.toFixed(2)} today over ${plural(f.turnsToday, 'turn')}` : 'spent nothing today'
  const parts = [
    f.version ? `I'm running ${f.version.split(' ')[0]}.` : f.upSec === undefined ? "I'm running." : '',
    f.upSec === undefined ? `I've ${spent}.` : `I've been up ${spoken(ago(f.upSec * 1000))} and ${spent}.`,
    f.schedules ? `${plural(f.schedules, 'schedule')}.` : '',
    f.starts.total > 1 ? `${startsLine(f.starts)}.` : '',
  ]
  const times = (k: number) => k === 1 ? 'once' : `${k} times`
  const bad = [...f.starts.crash ? [`crashed ${times(f.starts.crash)}`] : [], ...f.starts.unknown ? [`stopped ${times(f.starts.unknown)} without saying why`] : []]
  return { says: parts.filter(Boolean).join(' '), warn: bad.length ? `I ${bad.join(' and ')} in the last 24 hours.` : undefined }
}
