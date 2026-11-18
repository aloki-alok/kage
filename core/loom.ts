import type { Row, State } from './board.ts'
import { OFF_SLACK, type Conversation } from './conversations.ts'
import { HERO_BIG, HERO_SMALL } from './hero.ts'

export type Layout = {
  mode: 'big' | 'small' | 'none'
  hero?: { x: number; y: number; cols: number; rows: number }
  star?: { x: number; y: number }
  lx: number
  right: number
  rowH: number
  live: { key: string; y: number }[]
  ended: { key: string; y: number }[]
  sepY: number
  more: number
  moreY?: number
}

const ROW_MAX = 72
const TOP = 5
const HEROES = { big: { cols: 46, rows: 23 }, small: { cols: 32, rows: 16 } }
const starOf = (cls: string[]) => { const y = cls.findIndex(r => r.includes('g')); return { x: cls[y]!.indexOf('g'), y } }
const STARS = { big: starOf(HERO_BIG.cls), small: starOf(HERO_SMALL.cls) }

export function layout(cols: number, rows: number, live: string[], ended: string[]): Layout {
  const mode = cols >= 100 && rows >= 30 ? 'big' : cols >= 70 && rows >= 22 ? 'small' : 'none'
  let lx = 4
  let hero: Layout['hero'], star: Layout['star']
  if (mode !== 'none') {
    const h = HEROES[mode]
    hero = { x: 1, y: 4, ...h }
    star = { x: hero.x + STARS[mode].x, y: hero.y + STARS[mode].y }
    lx = hero.x + h.cols + (mode === 'big' ? 14 : 10)
  }
  const right = Math.min(cols - 2, lx + ROW_MAX)
  const floor = rows - 4
  let rowH = 3
  while (rowH > 1 && TOP + live.length * rowH + 3 > floor) rowH--
  const fit = Math.max(0, Math.min(live.length, Math.floor((floor - TOP - 1) / rowH)))
  const liveAt = live.slice(0, fit).map((key, i) => ({ key, y: TOP + i * rowH }))
  const sepY = TOP + fit * rowH
  const room = Math.max(0, floor - (sepY + 1))
  const shown = ended.slice(0, room)
  const more = ended.length - shown.length
  return {
    mode, ...(hero && { hero }), ...(star && { star }), lx, right, rowH, live: liveAt, sepY, more,
    ended: shown.map((key, i) => ({ key, y: sepY + 1 + i })),
    ...(more > 0 && { moreY: rows - 3 }),
  }
}

export function hit(l: Layout, x: number, y: number): string | undefined {
  if (x < l.lx - 4 || x > l.right) return undefined
  for (const r of l.live) if (y >= r.y && y < r.y + Math.min(2, l.rowH)) return r.key
  return l.ended.find(r => r.y === y)?.key
}

export const filterRows = (rows: Row[], query: string): Row[] => {
  const q = query.trim().toLowerCase()
  return q ? rows.filter(r => r.place.toLowerCase().includes(q)) : rows
}

const CONNECTORS: Conversation['connector'][] = ['slack', ...Object.keys(OFF_SLACK) as (keyof typeof OFF_SLACK)[]]
export function moreLine(rest: { connector: string }[]): string {
  const counts = CONNECTORS.map(c => `${c} ${rest.filter(r => r.connector === c).length}`)
  return ['+ ' + rest.length + ' more', ...counts, '/ to search'].join(' · ')
}

type Tone = 'red' | 'gold' | 'white' | 'muted' | 'dim'
export const STRING: Record<State, { kind: 'pulse' | 'blink' | 'drift' | 'dotted' | 'grow' | 'cut' | 'none'; tone: Tone; glyph: string }> = {
  working: { kind: 'pulse', tone: 'red', glyph: '●' },
  asking: { kind: 'blink', tone: 'gold', glyph: '◆' },
  watching: { kind: 'drift', tone: 'white', glyph: '◷' },
  quiet: { kind: 'dotted', tone: 'muted', glyph: '○' },
  starting: { kind: 'grow', tone: 'gold', glyph: '✦' },
  held: { kind: 'dotted', tone: 'muted', glyph: '▣' },
  queued: { kind: 'none', tone: 'gold', glyph: '…' },
  closed: { kind: 'cut', tone: 'dim', glyph: '╳' },
}

