import { ago } from './board.ts'
import { parseSessionKey } from './conversations.ts'
import type { KageEvent } from './events.ts'
import type { Tokens } from './ledgers.ts'

type Cost = { at: number; key: string; usd: number; tokens?: Tokens }
const DAY = 86_400_000
const money = (n: number) => `$${n.toFixed(2)}`
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`
const localDay = (t: number) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }
const percentile = (sorted: number[], p: number) => sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)]!
const connectorOf = (key: string) => key.includes('#side-kagelet-') ? 'kagelets' : parseSessionKey(key)?.conversation.connector ?? 'other'
const tokensIn = (t: Tokens) => t.input + t.cacheWrite + t.cacheRead
const sum = <T>(xs: T[], f: (x: T) => number) => xs.reduce((a, x) => a + f(x), 0)

type Input = { costs: Cost[]; events: KageEvent[]; boots: number[]; days: number; now: number; reports?: string }
type Stats = {
  days: number; usd: number; turns: number
  perDay: { day: string; usd: number; turns: number; tokensIn: number | null }[]
  byConnector: Record<string, number>
  tokens: { in: number; cacheRead: number; out: number; turns: number; turnsBefore: number; byKind: Record<string, number> } | null
  byModel: { model: string; usd: number; turns: number }[]
  hubStarts24h: number
  runs: { started: number; ended: number; refusals: number }
  turnTimeMs: { p50: number; p90: number } | null
  reports: Record<string, number>
  posts: { byKind: { kind: string; count: number; byToken: Record<string, number>; byChannel: Record<string, number> }[]; edited: number; deleted: number } | null
}

function collect(f: Input): { stats: Stats; empty: boolean } {
  const from = new Date(f.now).setHours(0, 0, 0, 0) - (f.days - 1) * DAY
  const costs = f.costs.filter(c => c.at >= from && c.at <= f.now)
  const events = f.events.filter(e => { const t = Date.parse(e.at); return t >= from && t <= f.now })
  const boots = f.boots.filter(t => t > f.now - DAY && t <= f.now)
  const reports = reportCounts(f.reports ?? '', from, f.now)
  const perDay: Stats['perDay'] = []
  for (let start = new Date(f.now).setHours(0, 0, 0, 0); start >= from; start -= DAY) {
    const c = costs.filter(x => x.at >= start && x.at < start + DAY), kept = c.flatMap(x => x.tokens ? [x.tokens] : [])
    perDay.push({ day: localDay(start), usd: sum(c, x => x.usd), turns: c.length, tokensIn: kept.length ? sum(kept, tokensIn) : null })
  }
  const byConnector: Record<string, number> = {}
  for (const c of costs) byConnector[connectorOf(c.key)] = (byConnector[connectorOf(c.key)] ?? 0) + c.usd
  const starts = new Map(events.filter(e => e.kind === 'run.start').map(e => [e.trace, Date.parse(e.at)]))
  const ends = events.filter(e => e.kind === 'run.end')
  const took = ends.flatMap(e => starts.has(e.trace) ? [Date.parse(e.at) - starts.get(e.trace)!] : []).sort((a, b) => a - b)
  const stats: Stats = {
    days: f.days, usd: sum(costs, c => c.usd), turns: costs.length, perDay, byConnector, tokens: tokenStats(costs), byModel: modelStats(costs), hubStarts24h: boots.length,
    runs: { started: starts.size, ended: ends.length, refusals: events.filter(e => e.kind === 'refusal').length },
    turnTimeMs: took.length ? { p50: percentile(took, 0.5), p90: percentile(took, 0.9) } : null, reports, posts: postStats(events),
  }
  return { stats, empty: !costs.length && !events.length && !boots.length && !Object.keys(reports).length }
}

export const statsData = (f: Input): Stats => collect(f).stats

export function statsLines(f: Input): string[] {
  const { stats: d, empty } = collect(f)
  const span = `Last ${plural(d.days, 'day')}`
  if (empty) return [`${span}: nothing spent, no runs, no hub starts.`]
  const lines = [`${span}: ${money(d.usd)} over ${plural(d.turns, 'turn')}`, '']
  for (const p of d.perDay) lines.push(`${p.day.slice(5)}  ${money(p.usd).padStart(8)}  ${plural(p.turns, 'turn')}${p.tokensIn === null ? '' : `  ${kilo(p.tokensIn)} tokens in`}`)
  const by = Object.entries(d.byConnector)
  if (by.length) lines.push('', `by connector: ${by.map(([k, usd]) => `${k} ${money(usd)}`).join(' · ')}`)
  if (d.tokens) {
    const t = d.tokens
    lines.push(`tokens: ${kilo(t.in)} in, ${t.in ? Math.round(100 * t.cacheRead / t.in) : 0}% read from cache, ${kilo(t.out)} out over ${plural(t.turns, 'turn')}${t.turnsBefore ? ` (${plural(t.turnsBefore, 'turn')} from before tokens were kept)` : ''}`,
      `by kind: ${Object.entries(t.byKind).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${kilo(n)}`).join(' · ')}`)
  }
  if (d.byModel.length) lines.push(`by model: ${d.byModel.map(m => `${m.model} ${money(m.usd)} over ${plural(m.turns, 'turn')}`).join(' · ')}`)
  lines.push(`hub: ${plural(d.hubStarts24h, 'start')} in the last 24 h`, `runs: ${d.runs.started} started, ${d.runs.ended} ended, ${plural(d.runs.refusals, 'refusal')}`)
  if (d.turnTimeMs) lines.push(`turn time: p50 ${ago(d.turnTimeMs.p50)}, p90 ${ago(d.turnTimeMs.p90)}`)
  const counts = OUTCOMES.flatMap(([o, label]) => d.reports[o] ? [`${d.reports[o]} ${label}`] : [])
  return [...lines, ...postLines(d.posts), ...counts.length ? [`reports to the Kage repo: ${counts.join(', ')}`] : []]
}

const LATER = ['edited', 'deleted']

function tally(posts: string[][], field: number): Record<string, number> {
  const by = new Map<string, number>()
  for (const p of posts) by.set(p[field] ?? '', (by.get(p[field] ?? '') ?? 0) + 1)
  return Object.fromEntries([...by].sort((a, b) => b[1] - a[1]))
}

function postStats(events: KageEvent[]): Stats['posts'] {
  const byKind = new Map<string, string[][]>()
  for (const e of events) if (e.kind === 'post') { const p = e.detail.split(' '); byKind.set(p[0]!, [...byKind.get(p[0]!) ?? [], p]) }
  if (!byKind.size) return null
  const sent = [...byKind].filter(([k]) => !LATER.includes(k)).sort((a, b) => b[1].length - a[1].length)
  return { byKind: sent.map(([kind, ps]) => ({ kind, count: ps.length, byToken: tally(ps, 1), byChannel: tally(ps, 2) })), edited: byKind.get('edited')?.length ?? 0, deleted: byKind.get('deleted')?.length ?? 0 }
}

function postLines(posts: Stats['posts']): string[] {
  if (!posts) return []
  const width = Math.max(16, ...posts.byKind.map(p => p.kind.length))
  const joined = (by: Record<string, number>) => Object.entries(by).map(([k, n]) => `${k} ${n}`).join(' · ')
  return [
    'posts by kind:',
    ...posts.byKind.map(p => `  ${p.kind.padEnd(width)}  ${String(p.count).padStart(4)}  ${joined(p.byToken)}  ${joined(p.byChannel)}`),
    `  later: ${posts.edited} edited, ${posts.deleted} deleted`,
  ]
}

const OUTCOMES: [string, string][] = [['filed', 'filed'], ['commented', 'seen again'], ['link', 'by link'], ['denied', 'denied'], ['capped', 'capped'], ['failed', 'failed']]

function reportCounts(tsv: string, from: number, now: number): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const line of tsv.split('\n')) {
    const [at = '', , , outcome = ''] = line.split('\t'), t = Date.parse(at)
    if (t >= from && t <= now && OUTCOMES.some(([o]) => o === outcome)) counts[outcome] = (counts[outcome] ?? 0) + 1
  }
  return counts
}

const kilo = (n: number) => n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)

function modelStats(costs: Cost[]): Stats['byModel'] {
  const by = new Map<string, { usd: number; turns: number }>()
  for (const c of costs) if (c.tokens?.model) { const m = by.get(c.tokens.model) ?? { usd: 0, turns: 0 }; by.set(c.tokens.model, { usd: m.usd + c.usd, turns: m.turns + 1 }) }
  return [...by].sort((a, b) => b[1].usd - a[1].usd).map(([model, x]) => ({ model, ...x }))
}

function tokenStats(costs: Cost[]): Stats['tokens'] {
  const kept = costs.flatMap(c => c.tokens ? [c.tokens] : [])
  if (!kept.length) return null
  const byKind: Record<string, number> = {}
  for (const t of kept) byKind[t.who] = (byKind[t.who] ?? 0) + tokensIn(t)
  return { in: sum(kept, tokensIn), cacheRead: sum(kept, t => t.cacheRead), out: sum(kept, t => t.output), turns: kept.length, turnsBefore: costs.length - kept.length, byKind }
}
