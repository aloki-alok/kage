import type { Schedule } from './cron.ts'
import { spendSince } from './ledgers.ts'

const DAY = 24 * 3600_000, WEEK = 7 * DAY
const MANY_RUNS = 20, QUIET_SHARE = 0.1

export function retroDue(now: number, last: number | undefined): boolean {
  const d = new Date(now)
  return d.getDay() >= 1 && (d.getDay() > 1 || d.getHours() >= 9) && (last === undefined || now - last >= 6 * DAY)
}

const rows = (tsv: string, since: number) => tsv.split('\n').map(l => l.split('\t')).filter(c => Date.parse(c[0]!) >= since)

export function retro(o: {
  schedules: Schedule[]
  placeOf: (key: string) => string
  runs: string
  posted: string
  costs: string
  costTracked?: boolean
  now: number
}): string[] {
  const since = o.now - WEEK
  const runs = new Map<string, number>()
  for (const [, id] of rows(o.runs, since)) runs.set(id!, (runs.get(id!) ?? 0) + 1)
  const posts = new Map<string, number>()
  for (const [, , , by, key] of rows(o.posted, since)) if ((by === 'bot' || by === 'owner') && key) posts.set(key, (posts.get(key) ?? 0) + 1)
  const quiet: string[] = []
  for (const s of o.schedules) {
    const ran = runs.get(s.id) ?? 0
    const posted = posts.get(s.key) ?? 0
    if (ran >= MANY_RUNS && posted <= ran * QUIET_SHARE) {
      quiet.push(`• ${s.id} in ${o.placeOf(s.key)}: ran ${ran} times this week, posted ${posted} time${posted === 1 ? '' : 's'}. To stop it, tag Kage in that thread with "unschedule ${s.id}".`)
    }
  }
  const top = spendSince(o.costs, since).slice(0, 3)
  const spend = o.costTracked === false
    ? (quiet.length ? ['_Spend is not tracked while threads run as tmux panes, only on the Agent SDK runner._'] : [])
    : top.length ? ['*Most spent this week*', ...top.map(t => `• $${t.usd.toFixed(2)} ${o.placeOf(t.key)} (${t.turns} turns)`)] : []
  return [...(quiet.length ? ['*Schedules that run a lot and rarely say anything*', ...quiet] : []), ...spend]
}
