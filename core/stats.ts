import { ago } from './board.ts'
import { parseSessionKey } from './conversations.ts'
import type { KageEvent } from './events.ts'

type Cost = { at: number; key: string; usd: number }
const DAY = 86_400_000
const money = (n: number) => `$${n.toFixed(2)}`
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`
const dayLabel = (t: number) => { const d = new Date(t); return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }
const percentile = (sorted: number[], p: number) => sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)]!
const connectorOf = (key: string) => key.includes('#side-kagelet-') ? 'kagelets' : parseSessionKey(key)?.conversation.connector ?? 'other'

export function statsLines(f: { costs: Cost[]; events: KageEvent[]; boots: number[]; days: number; now: number }): string[] {
  const from = new Date(f.now).setHours(0, 0, 0, 0) - (f.days - 1) * DAY
  const costs = f.costs.filter(c => c.at >= from && c.at <= f.now)
  const events = f.events.filter(e => { const t = Date.parse(e.at); return t >= from && t <= f.now })
  const boots = f.boots.filter(t => t > f.now - DAY && t <= f.now)
  const span = `Last ${plural(f.days, 'day')}`
  if (!costs.length && !events.length && !boots.length) return [`${span}: nothing spent, no runs, no hub starts.`]
  const total = costs.reduce((a, c) => a + c.usd, 0)
  const lines = [`${span}: ${money(total)} over ${plural(costs.length, 'turn')}`, '']
  for (let start = new Date(f.now).setHours(0, 0, 0, 0); start >= from; start -= DAY) {
    const inDay = <T>(xs: T[], at: (x: T) => number) => xs.filter(x => at(x) >= start && at(x) < start + DAY)
    const c = inDay(costs, x => x.at)
    lines.push(`${dayLabel(start)}  ${money(c.reduce((a, x) => a + x.usd, 0)).padStart(8)}  ${plural(c.length, 'turn')}`)
  }
  const by = new Map<string, number>()
  for (const c of costs) by.set(connectorOf(c.key), (by.get(connectorOf(c.key)) ?? 0) + c.usd)
  if (by.size) lines.push('', `by connector: ${[...by].map(([k, usd]) => `${k} ${money(usd)}`).join(' · ')}`)
  const starts = new Map(events.filter(e => e.kind === 'run.start').map(e => [e.trace, Date.parse(e.at)]))
  const ends = events.filter(e => e.kind === 'run.end')
  const refusals = events.filter(e => e.kind === 'refusal').length
  lines.push(`hub: ${plural(boots.length, 'start')} in the last 24 h`)
  lines.push(`runs: ${starts.size} started, ${ends.length} ended, ${plural(refusals, 'refusal')}`)
  const took = ends.flatMap(e => starts.has(e.trace) ? [Date.parse(e.at) - starts.get(e.trace)!] : []).sort((a, b) => a - b)
  if (took.length) lines.push(`turn time: p50 ${ago(percentile(took, 0.5))}, p90 ${ago(percentile(took, 0.9))}`)
  return lines
}
