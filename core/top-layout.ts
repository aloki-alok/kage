import type { Row, State } from './board.ts'

export type Rect = { x0: number; y0: number; x1: number; y1: number }
export type Screen = { banner?: number; list: Rect; feed?: Rect; charts?: Rect[] }

const WIDE = 110
const CHARTS_FROM = 30
const CHART_ROWS = 9

export function screen(cols: number, rows: number, asking: boolean): Screen {
  const top = asking ? 2 : 1
  const footer = rows - 1
  const charts = rows >= CHARTS_FROM ? footer - 1 - CHART_ROWS : undefined
  const bottom = (charts ?? footer) - 1
  const wide = cols >= WIDE
  const split = wide ? Math.round(cols * 0.53) : cols - 2
  const list = { x0: 1, y0: top + 1, x1: split, y1: bottom }
  const out: Screen = { ...(asking && { banner: 1 }), list }
  if (wide) out.feed = { x0: split + 2, y0: top + 1, x1: cols - 2, y1: bottom }
  if (charts !== undefined) {
    const a = Math.round(cols * 0.4), b = Math.round(cols * 0.7)
    out.charts = [
      { x0: 1, y0: charts, x1: a, y1: footer - 1 },
      { x0: a + 2, y0: charts, x1: b, y1: footer - 1 },
      { x0: b + 2, y0: charts, x1: cols - 2, y1: footer - 1 },
    ]
  }
  return out
}

export function listRows(keys: string[], selected: string, room: number): { key: string; y: number }[] {
  const at = Math.max(0, keys.indexOf(selected))
  const from = Math.max(0, at - room + 1)
  return keys.slice(from, from + room).map((key, y) => ({ key, y }))
}

export const rowAt = (rows: { key: string; y: number }[], y: number) => rows.find(r => r.y === y)?.key

export function perMinute(times: number[], now: number, width: number): number[] {
  const bins = new Array<number>(width).fill(0)
  for (const t of times) {
    const age = now - t
    if (!(age >= 0 && age < 3_600_000)) continue
    bins[width - 1 - Math.floor(age / (3_600_000 / width))]!++
  }
  return bins
}

export function perHour(costs: { at: number; usd: number }[], now: number): number[] {
  const midnight = new Date(now).setHours(0, 0, 0, 0)
  const hours = new Array<number>(new Date(now).getHours() + 1).fill(0)
  for (const c of costs) {
    if (!(c.at >= midnight && c.at <= now)) continue
    const h = new Date(c.at).getHours()
    hours[h] = Math.round((hours[h]! + c.usd) * 1e6) / 1e6
  }
  return hours
}

const EIGHTHS = ' ▁▂▃▄▅▆▇█'
export function bars(values: number[], height: number): string[] {
  const max = Math.max(0, ...values)
  const eighths = values.map(v => (max > 0 ? Math.round((v / max) * height * 8) : 0))
  return Array.from({ length: height }, (_, row) => {
    const floor = (height - 1 - row) * 8
    return eighths.map(e => EIGHTHS[Math.max(0, Math.min(8, e - floor))]!).join('')
  })
}

export type Tone = 'work' | 'you' | 'ink' | 'mid' | 'dim'
export const MARK: Record<State, { glyph: string; tone: Tone }> = {
  asking: { glyph: '◆', tone: 'you' },
  working: { glyph: '•', tone: 'work' },
  starting: { glyph: '✦', tone: 'work' },
  watching: { glyph: '◷', tone: 'ink' },
  queued: { glyph: '…', tone: 'mid' },
  held: { glyph: '▣', tone: 'mid' },
  quiet: { glyph: '◌', tone: 'dim' },
  closed: { glyph: '◌', tone: 'dim' },
}

const SPIN = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'
export const spinner = (t: number) => SPIN[Math.floor(t / 100) % SPIN.length]!

export const filterRows = (rows: Row[], query: string): Row[] => {
  const q = query.trim().toLowerCase()
  return q ? rows.filter(r => r.place.toLowerCase().includes(q)) : rows
}
