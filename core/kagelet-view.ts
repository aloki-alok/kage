// What the owner sees of kagelets in a terminal: the panel in kage top, its keys, and kage logs <kagelet>.
// The actions go to the hub's manager (runtime/kagelets.ts), the same one Kage's own tool uses.
import { clockTime, whenLabel } from './board.ts'
import type { KageletRow, Report } from './kagelets.ts'

// The cost caps are off unless set (#96). A set value that is not a number of dollars, or is below zero, is off
// too, and capError names it, so the hub says so at start instead of guarding nothing in silence.
type Env = Record<string, string | undefined>
const dollars = (v: string | undefined) => { const n = Number(v); return v && Number.isFinite(n) && n >= 0 ? n : undefined }
const daily = (env: Env) => env.KAGE_KAGELET_DAILY_USD || env.KAGE_SPECIALIST_DAILY_USD
// KAGE_KAGELET_DAILY_USD, or its name from before the rename. The hub pauses a kagelet at it.
export const dailyCap = (env: Env) => dollars(daily(env))
// KAGE_KAGELET_TOTAL_DAILY_USD: all kagelets together. The hub pauses every one at it.
export const totalCap = (env: Env) => dollars(env.KAGE_KAGELET_TOTAL_DAILY_USD)
// KAGE_KAGELET_CHAIN_USD: one chain of kagelet handoffs and messages (#93). The hub stops the chain at it.
export const chainCap = (env: Env) => dollars(env.KAGE_KAGELET_CHAIN_USD)
export const capError = (env: Env) => [['KAGE_KAGELET_DAILY_USD', daily(env)], ['KAGE_KAGELET_TOTAL_DAILY_USD', env.KAGE_KAGELET_TOTAL_DAILY_USD],
  ['KAGE_KAGELET_CHAIN_USD', env.KAGE_KAGELET_CHAIN_USD]]
  .filter(([, v]) => v && dollars(v) === undefined).map(([k]) => `${k} is not a number of dollars, so that cap is off`).join('. ') || undefined

// On: enabled and waiting for its schedule (a run in progress shows in kage logs). Over cap: what it spent
// today reached the cap, so the hub paused it (or will at its next sync). Only with a cap set.
export const shownState = (r: KageletRow, cap: number | undefined) =>
  r.state === 'broken' ? 'broken' : cap !== undefined && r.costToday >= cap ? 'over cap' : r.state === 'paused' ? 'paused' : 'on'

// How the hub's cost-cap report starts (costCap in runtime/kagelets.ts), so kage logs can tell that run apart.
export const CAP_PAUSE = 'paused: it spent'

const reportText =(r: Report) => r.needs ? `needs: ${r.needs} (${r.summary})` : r.summary

// The cost column: today against its 7-day daily average (#96). The cap, if set, is in the panel's head.
export function panelLines(rows: KageletRow[], now: number, cap?: number) {
  return rows.map(r => r.state === 'broken' ? { main: `${r.name.padEnd(16)} ${'broken'.padEnd(8)} ${r.error}`, report: '' } : {
    main: [r.name.padEnd(16), shownState(r, cap).padEnd(8), `last ${r.lastRun ? whenLabel(r.lastRun, now) : 'never'}`.padEnd(14),
      `next ${whenLabel(r.next, now)}`.padEnd(14), `$${r.costToday.toFixed(2)} avg $${r.avg7.toFixed(2)}`.padEnd(16), `by ${r.by === 'kage' ? 'Kage' : 'owner'}${r.standing ? ', standing' : ''}`].join(' '),
    report: r.result ? `${clockTime(r.result.at, now)} ${reportText(r.result)}` : 'no report yet',
  })
}

// The actions the panel may ask the hub for. Saving a file stays with Kage and the owner's editor.
// revoke: the standing db_read approval (#96), whichever row is picked.
export type PanelAction = 'run' | 'pause' | 'resume' | 'remove' | 'revoke'
export const PANEL_KEYS: Record<string, PanelAction> = { r: 'run', p: 'pause', u: 'resume', x: 'remove', v: 'revoke' }

// The hub's answer to one action. undefined: no answer, and up says whether the hub runs at all.
export function actionLine(r: { type?: string; text?: string; refused?: string } | undefined, up: boolean) {
  if (r?.type !== 'kagelet') r = undefined
  if (r?.text) return r.text
  if (r?.refused) return `The hub refused: ${r.refused}.`
  return up ? 'The hub does not answer. If it runs older code, kage restart picks up the kagelet keys.'
    : 'Kage is not running, so it cannot act on kagelets. Start it with kage start.'
}

// One run: from its row in the runs ledger to the next one. Its cost is what its lane spent in between,
// and its report the last one filed. A run with no report failed, unless it is the latest and under an hour old.
// The hub's cap report, filed in the run that reached the cap, marks it paused for cost.
export type Run = { at: number; usd: number; status: 'ok' | 'failed' | 'running' | 'paused for cost'; report: string }
export function kageletRuns(name: string, key: string, l: { runs: string; costs: string; reports: string }, now: number): Run[] {
  const rows = (tsv: string) => tsv.split('\n').filter(Boolean).map(x => x.split('\t'))
  const starts = rows(l.runs).filter(([, id]) => id === `kagelet-${name}` || id === `spec-${name}`).map(([t]) => Date.parse(t!)).sort((a, b) => a - b)
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

export const runLine = (r: Run, now: number) => [clockTime(r.at, now).padEnd(16), `$${r.usd.toFixed(2)}`.padEnd(7), r.status.padEnd(15), r.report].join(' ')
