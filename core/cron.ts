// Schedules the hub owns: cron expressions read the way Claude Code's CronCreate reads them (5
// fields, local time), which of them fire now, and the jobs a Claude Code transcript still holds.
// A schedule here survives a hub restart and does not need its session to stay open.

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

export function cronMatches(expr: string | Cron, d: Date): boolean {
  const c = typeof expr === 'string' ? parseCron(expr) : expr
  const [min, hour, dom, mon, dow] = c.sets as [Set<number>, Set<number>, Set<number>, Set<number>, Set<number>]
  if (!min.has(d.getMinutes()) || !hour.has(d.getHours()) || !mon.has(d.getMonth() + 1)) return false
  // As in cron: with both day fields set, either one matching is enough.
  const day = dom.has(d.getDate()), weekday = dow.has(d.getDay())
  return c.anyDay || c.anyWeekday ? day && weekday : day || weekday
}

const MINUTE = 60_000
const minuteOf = (t: number) => Math.floor(t / MINUTE) * MINUTE

// The first run after `from`, within `withinMs`.
export function nextRun(expr: string, from: Date, withinMs: number): Date | undefined {
  const c = parseCron(expr)
  for (let t = minuteOf(from.getTime()) + MINUTE; t <= from.getTime() + withinMs; t += MINUTE) if (cronMatches(c, new Date(t))) return new Date(t)
  return undefined
}

export type Schedule = {
  id: string
  key: string            // the thread whose session runs it
  cron: string
  prompt: string
  recurring: boolean
  fromOwner: boolean     // who asked for it: each run gets the same trust as that first task
  created: number
  lastFired: number
  ends?: number          // when set: the schedule is dropped from then on (only jobs adopted from CronCreate)
}

// A recurring run missed by more than this (the hub was down) is skipped; the next one runs as usual.
const LATE = 10 * MINUTE

// fire: run now, once each. drop: remove a one-shot once it fired, or a job past its `ends`. Nothing
// else ends a schedule: unlike CronCreate's jobs, these stop only when someone cancels them.
export function dueSchedules(all: Schedule[], now: number): { fire: Schedule[]; drop: string[] } {
  const fire: Schedule[] = [], drop: string[] = []
  for (const s of all) {
    if (s.ends && now >= s.ends) { drop.push(s.id); continue }
    let c: Cron
    try { c = parseCron(s.cron) } catch { continue }   // added through schedule(), which checks it
    if (!s.recurring) {
      // However late: a one-time job the hub missed while down still runs once.
      if (s.lastFired) { drop.push(s.id); continue }
      for (let t = minuteOf(s.created) + MINUTE; t <= now; t += MINUTE) {
        if (!cronMatches(c, new Date(t))) continue
        fire.push(s); drop.push(s.id)
        break
      }
      continue
    }
    // After the clock steps back: a small step (under LATE) may land on minutes that already ran, so
    // nothing runs until the clock catches up. A big one must not silence the job for hours, so only
    // the current minute may run.
    if (s.lastFired > now && s.lastFired - now < LATE) continue
    const last = s.lastFired > now ? minuteOf(now) - 1 : s.lastFired
    for (let t = minuteOf(now); t > Math.max(last, s.created, now - LATE); t -= MINUTE) {
      if (!cronMatches(c, new Date(t))) continue
      fire.push(s)
      break
    }
  }
  return { fire, drop }
}

// What Claude Code's CronCreate and CronDelete answer, the only record of a job outside its process.
// A wording change in Claude Code breaks these two, and with them "watching" and the job import.
const CRON_MADE = /Scheduled (\S+) job ([0-9a-f]+)/
const CRON_CANCELLED = /Cancelled job ([0-9a-f]+)/
// Claude Code drops a recurring job after 7 days. ponytail: a one-shot counts for a day, since its fire time isn't parsed.
export const CRON_RECURRING_TTL = 7 * 24 * 3600_000
const CRON_ONE_SHOT_TTL = 24 * 3600_000

// The CronCreate jobs a Claude Code transcript still holds: made by the process running since
// `since` (Claude Code keeps them only in memory) and not cancelled. Used to move them into the hub.
export function cronJobsFromTranscript(lines: string[], since: number) {
  const made = new Map<string, { cron: string; prompt: string; recurring: boolean; created?: number }>()   // tool_use id ->
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

// Repeating checks a session made with CronCreate live only in its Claude Code process, so
// closing the pane ends them. These are the jobs still alive: made since `since` (when the
// running process started), not cancelled, and not expired (see CRON_RECURRING_TTL).
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
