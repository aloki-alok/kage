import { clockTime, whenLabel } from './board.ts'
import type { KageletRow, Report } from './kagelets.ts'

type Caps = { dailyUsd?: number | null; totalDailyUsd?: number | null; chainUsd?: number | null }
const dollars = (v: number | null | undefined) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined)
export const dailyCap = (k: Caps = {}) => dollars(k.dailyUsd)
export const totalCap = (k: Caps = {}) => dollars(k.totalDailyUsd)
export const chainCap = (k: Caps = {}) => dollars(k.chainUsd)
export const shownState = (r: KageletRow, cap: number | undefined) =>
  r.state === 'broken' ? 'broken' : cap !== undefined && r.costToday >= cap ? 'over cap' : r.state === 'paused' ? 'paused' : 'on'

export const CAP_PAUSE = 'paused: it spent'

const reportText =(r: Report) => r.needs ? `needs: ${r.needs} (${r.summary})` : r.summary

export type PanelAction = 'run' | 'pause' | 'resume' | 'remove' | 'revoke'
export const PANEL_KEYS: Record<string, PanelAction> = { r: 'run', p: 'pause', u: 'resume', x: 'remove', v: 'revoke' }

export function actionLine(r: { type?: string; text?: string; refused?: string } | undefined, up: boolean) {
  if (r?.type !== 'kagelet') r = undefined
  if (r?.text) return r.text
  if (r?.refused) return `The hub refused: ${r.refused}.`
  return up ? 'The hub does not answer. If it runs older code, kage restart picks up the kagelet keys.'
    : 'Kage is not running, so it cannot act on kagelets. Start it with kage start.'
}

export type Run = { at: number; usd: number; status: 'ok' | 'failed' | 'running' | 'paused for cost'; report: string }
export function kageletRuns(name: string, key: string, l: { runs: string; costs: string; reports: string }, now: number): Run[] {
  const rows = (tsv: string) => tsv.split('\n').filter(Boolean).map(x => x.split('\t'))
  const starts = rows(l.runs).filter(([, id]) => id === `kagelet-${name}`).map(([t]) => Date.parse(t!)).sort((a, b) => a - b)
  const costs = rows(l.costs).filter(([, k]) => k === key).map(([t, , usd]) => ({ at: Date.parse(t!), usd: Number(usd) }))
  const reports = rows(l.reports).filter(([, n]) => n === name).map(([t, , summary = '', needs]) => ({ at: Date.parse(t!), summary, ...(needs && { needs }) }))
  return starts.map((at, i): Run => {
    const end = starts[i + 1] ?? Infinity
    const inRun = (x: { at: number }) => x.at >= at && x.at < end
    const usd = Math.round(costs.filter(inRun).reduce((s, c) => s + c.usd, 0) * 1e6) / 1e6
    const rep = reports.filter(inRun).at(-1)
    if (rep?.summary.startsWith(CAP_PAUSE)) return { at, usd, status: 'paused for cost', report: rep.summary }
    if (rep) return { at, usd, status: 'ok', report: reportText(rep) }
    return end === Infinity && now - at < 3_600_000 ? { at, usd, status: 'running', report: 'no report yet' } : { at, usd, status: 'failed', report: 'no report: the run ended without one' }
  }).reverse()
}

export const modelLine = (k: { model: string; modelWhy: string }) => `model: ${k.model}${k.modelWhy ? ` (${k.modelWhy})` : ''}`

export const runLine = (r: Run, now: number) => [clockTime(r.at, now).padEnd(16), `$${r.usd.toFixed(2)}`.padEnd(7), r.status.padEnd(15), r.report].join(' ')

export function kageletLine(r: KageletRow, now: number): { text: string; tone: 'work' | 'quiet' | 'you' } {
  const name = r.name.padEnd(16)
  if (r.state === 'broken') return { text: `${name}broken: ${r.error}`, tone: 'you' }
  if (r.state === 'paused') return { text: `${name}paused`, tone: 'quiet' }
  const last = r.lastRun ? `last ran ${clockTime(r.lastRun, now)}` : 'never ran'
  return { text: `${name}${[last, `next ${whenLabel(r.next, now)}`, `$${r.costToday.toFixed(2)} today`].join(' · ')}`, tone: 'work' }
}
