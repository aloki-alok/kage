import type { Trigger } from './tripwire.ts'

const FIELDS = [['minute', 0, 59], ['hour', 0, 23], ['day of month', 1, 31], ['month', 1, 12], ['day of week', 0, 7]] as const
type Cron = { sets: Set<number>[]; anyDay: boolean; anyWeekday: boolean }

export function parseCron(expr: string): Cron {
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) throw new Error(`a cron expression has 5 fields: ${expr}`)
  const sets = parts.map((p, i) => {
    const [name, lo, hi] = FIELDS[i]!
    const set = new Set<number>()
    for (const item of p.split(',')) {
      const m = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(item)
      if (!m) throw new Error(`bad ${name}: ${item}`)
      const step = m[4] === undefined ? 1 : Number(m[4])
      if (step < 1) throw new Error(`bad step in ${name}: ${item}`)
      const from = m[1] === '*' ? lo : Number(m[2])
      const to = m[1] === '*' ? hi : m[3] !== undefined ? Number(m[3]) : m[4] !== undefined ? hi : from
      if (from < lo || to > hi || from > to) throw new Error(`bad ${name}: ${item}`)
      for (let v = from; v <= to; v += step) set.add(i === 4 && v === 7 ? 0 : v)
    }
    return set
  })
  return { sets, anyDay: parts[2] === '*', anyWeekday: parts[4] === '*' }
}

function dayMatches(c: Cron, d: Date): boolean {
  const [, , dom, mon, dow] = c.sets as [Set<number>, Set<number>, Set<number>, Set<number>, Set<number>]
  if (!mon.has(d.getMonth() + 1)) return false
  const day = dom.has(d.getDate()), weekday = dow.has(d.getDay())
  return c.anyDay || c.anyWeekday ? day && weekday : day || weekday
}

export function cronMatches(expr: string | Cron, d: Date): boolean {
  const c = typeof expr === 'string' ? parseCron(expr) : expr
  return c.sets[0]!.has(d.getMinutes()) && c.sets[1]!.has(d.getHours()) && dayMatches(c, d)
}

function lastMatch(c: Cron, from: number, floor: number): number | undefined {
  for (let t = from; t > floor;) {
    const d = new Date(t)
    if (!dayMatches(c, d)) { d.setHours(0, 0, 0, 0); t = d.getTime() - MINUTE; continue }
    if (!c.sets[1]!.has(d.getHours())) { d.setMinutes(0, 0, 0); t = d.getTime() - MINUTE; continue }
    if (c.sets[0]!.has(d.getMinutes())) return t
    t -= MINUTE
  }
  return undefined
}

function countMatches(c: Cron, from: number, floor: number): { newest?: number; count: number } {
  const newest = lastMatch(c, from, floor)
  let count = 0
  for (let t = newest; t !== undefined; t = lastMatch(c, t - MINUTE, floor)) count++
  return { newest, count }
}

const MINUTE = 60_000
const minuteOf = (t: number) => Math.floor(t / MINUTE) * MINUTE

export function nextRun(expr: string, from: Date, withinMs: number): Date | undefined {
  if (expr === REPLY || expr === EVENT) return undefined
  const c = parseCron(expr)
  for (let t = minuteOf(from.getTime()) + MINUTE; t <= from.getTime() + withinMs; t += MINUTE) if (cronMatches(c, new Date(t))) return new Date(t)
  return undefined
}

export const REPLY = '@reply'
export const EVENT = '@event'

export type Schedule = {
  id: string
  key: string
  cron: string
  prompt: string
  recurring: boolean
  fromOwner: boolean
  created: number
  lastFired: number
  lane?: true
  trigger?: Trigger
  ends?: number
  needs?: string[]
}

const LATE = 10 * MINUTE
export const CATCH_UP = 12 * 3600_000

export type Late = { due: number; missed: number }

export function dueSchedules(all: Schedule[], now: number, catchUp = CATCH_UP): { fire: Schedule[]; drop: string[]; late: Record<string, Late>; skipped: Record<string, number> } {
  const fire: Schedule[] = [], drop: string[] = [], late: Record<string, Late> = {}, skipped: Record<string, number> = {}
  for (const s of all) {
    if (s.ends && now >= s.ends) { drop.push(s.id); continue }
    if (s.cron === REPLY || s.cron === EVENT) continue
    let c: Cron
    try { c = parseCron(s.cron) } catch { continue }
    if (!s.recurring) {
      if (s.lastFired) { drop.push(s.id); continue }
      for (let t = minuteOf(s.created) + MINUTE; t <= now; t += MINUTE) {
        if (!cronMatches(c, new Date(t))) continue
        fire.push(s); drop.push(s.id)
        break
      }
      continue
    }
    if (s.lastFired > now && s.lastFired - now < LATE) continue
    const last = Math.max(s.lastFired > now ? minuteOf(now) - 1 : s.lastFired, s.created)
    const edge = now - Math.max(catchUp, LATE)
    const { newest: due, count: missed } = countMatches(c, minuteOf(now), Math.max(last, edge))
    if (due !== undefined) {
      fire.push(s)
      if (missed > 1 || now - due > LATE) late[s.id] = { due, missed }
      continue
    }
    const old = countMatches(c, minuteOf(edge), last).count
    if (old) skipped[s.id] = old
  }
  return { fire, drop, late, skipped }
}

const CRON_MADE = /Scheduled (\S+) job ([0-9a-f]+)/
const CRON_CANCELLED = /Cancelled job ([0-9a-f]+)/
export const CRON_RECURRING_TTL = 7 * 24 * 3600_000
const CRON_ONE_SHOT_TTL = 24 * 3600_000

export function cronJobsFromTranscript(lines: string[], since: number) {
  const made = new Map<string, { cron: string; prompt: string; recurring: boolean; created?: number }>()
  const jobs = new Map<string, { id: string; cron: string; prompt: string; recurring: boolean; created: number }>()
  const cancelled = new Set<string>()
  for (const raw of lines) {
    let r: { timestamp?: string; message?: { content?: unknown } }
    try { r = JSON.parse(raw) } catch { continue }
    const t = r.timestamp ? Date.parse(r.timestamp) : undefined
    if (!Array.isArray(r.message?.content)) continue
    for (const b of r.message!.content as { type?: string; id?: string; name?: string; input?: any; tool_use_id?: string; content?: unknown }[]) {
      if (b.type === 'tool_use' && b.name === 'CronCreate' && b.id && b.input?.cron) {
        made.set(b.id, { cron: b.input.cron, prompt: String(b.input.prompt ?? ''), recurring: b.input.recurring !== false, created: t })
      } else if (b.type === 'tool_result') {
        const text = typeof b.content === 'string' ? b.content : Array.isArray(b.content) ? b.content.map((c: { text?: string }) => c?.text ?? '').join('') : ''
        const ok = CRON_MADE.exec(text)
        const job = b.tool_use_id && made.get(b.tool_use_id)
        if (ok && job && !jobs.has(ok[2]!)) jobs.set(ok[2]!, { id: ok[2]!, cron: job.cron, prompt: job.prompt, recurring: job.recurring, created: job.created ?? t ?? 0 })
        const gone = CRON_CANCELLED.exec(text)
        if (gone) cancelled.add(gone[1]!)
      }
    }
  }
  return [...jobs.values()].filter(j => !cancelled.has(j.id) && j.created >= since)
}

export function liveCronJobs(results: { timestamp: string; text: string }[], since: number, now: number): string[] {
  const jobs = new Map<string, number>()
  for (const r of results) {
    const t = Date.parse(r.timestamp)
    const made = CRON_MADE.exec(r.text)
    if (made && t >= since) jobs.set(made[2]!, t + (made[1] === 'recurring' ? CRON_RECURRING_TTL : CRON_ONE_SHOT_TTL))
    const gone = CRON_CANCELLED.exec(r.text)
    if (gone) jobs.delete(gone[1]!)
  }
  return [...jobs].filter(([, until]) => now < until).map(([id]) => id)
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const DAYS = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays']
const two = (n: string) => n.padStart(2, '0')
export function cadence(cron: string): string {
  if (cron === REPLY) return 'when someone writes'
  if (cron === EVENT) return 'when its trigger fires'
  const f = cron.trim().split(/\s+/)
  if (f.length !== 5) return cron
  const [min, hour, dom, mon, dow] = f as [string, string, string, string, string]
  let when: string | undefined
  const every = /^\*\/(\d+)$/.exec(min)
  const range = /^(\d+)-(\d+)$/.exec(hour)
  if (dom !== '*' && dow !== '*') return cron
  if (every && 60 % Number(every[1]) === 0 && (hour === '*' || range)) when = `every ${every[1]} min${range ? `, ${two(range[1]!)}:00 to ${two(range[2]!)}:59` : ''}`
  else if (/^\d+$/.test(min) && range) when = `hourly at :${two(min)}, ${two(range[1]!)}:00 to ${two(range[2]!)}:59`
  else if (/^\d+$/.test(min) && /^\d+$/.test(hour)) when = `daily at ${two(hour)}:${two(min)}`
  if (!when) return cron
  if (dom !== '*' || mon !== '*') {
    if (!/^\d+$/.test(dom) || !/^\d+$/.test(mon)) return cron
    when += `, on ${dom} ${MONTHS[Number(mon) - 1]}`
  }
  if (dow === '1-5') when += ', weekdays'
  else if (/^[0-6]$/.test(dow)) when += `, ${DAYS[Number(dow)]}`
  else if (dow !== '*') return cron
  return when
}

export const promptPreview = (p: string) => p.split('\n')[0]!.replace(/\s*\([^)]*(\b[BCDGTUW](?=[0-9A-Z]*\d)[0-9A-Z]{8,}\b|\d{10}\.\d{6})[^)]*\)/g, '').replace(/\s*(?:thread|channel)?\s*\b[BCDGTUW](?=[0-9A-Z]*\d)[0-9A-Z]{8,}\b(?:\s*\/\s*\d{10}\.\d{6})?/g, '').replace(/\s+/g, ' ').trim()
