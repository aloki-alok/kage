// The loom, as `kage top` lays it out: Kage on the left, a string from its hand to each live
// thread, ended threads as one dim row each. Pure: positions, mouse hits, search, the count line.
import type { Row, State } from './board.ts'

export type Layout = {
  mode: 'big' | 'small' | 'none'
  hero?: { x: number; y: number; cols: number; rows: number }
  hand?: { x: number; y: number; cols: number; rows: number }   // the hand's art; strings leave its fingertips
  lx: number                            // where a row's name starts
  right: number                         // last column of a row
  rowH: number                          // lines per live row: name, step, a blank
  live: { key: string; y: number }[]
  ended: { key: string; y: number }[]
  sepY: number
  more: number                          // ended threads that did not fit
  moreY?: number
}

const TOP = 5   // first live row: below the wordmark and Kage's crown
const HEROES = { big: { cols: 46, rows: 23 }, small: { cols: 32, rows: 16 } }
// The hand reaches out of Kage's right edge: `overlap` columns lie over Kage, `dy` below Kage's top.
const HANDS = { big: { cols: 40, rows: 14, overlap: 28, dy: 8 }, small: { cols: 28, rows: 10, overlap: 18, dy: 5 } }

export function layout(cols: number, rows: number, live: string[], ended: string[]): Layout {
  const mode = cols >= 100 && rows >= 30 ? 'big' : cols >= 70 && rows >= 22 ? 'small' : 'none'
  const right = cols - 2
  let lx = 4
  let hero: Layout['hero'], hand: Layout['hand']
  if (mode !== 'none') {
    const h = HEROES[mode]
    hero = { x: 1, y: 4, ...h }
    const m = HANDS[mode]
    hand = { x: 1 + h.cols - m.overlap, y: 4 + m.dy, cols: m.cols, rows: m.rows }
    lx = hand.x + hand.cols + (mode === 'big' ? 8 : 6)
  }
  // Rows shrink (3 lines, 2, 1) before the ended list gives up room; never more live rows than lines.
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
    mode, ...(hero && { hero }), ...(hand && { hand }), lx, right, rowH, live: liveAt, sepY, more,
    ended: shown.map((key, i) => ({ key, y: sepY + 1 + i })),
    ...(more > 0 && { moreY: rows - 3 }),
  }
}

// The thread under a screen cell: a live row's name and step lines, or an ended row's line, from
// just left of its string end to the right edge.
export function hit(l: Layout, x: number, y: number): string | undefined {
  if (x < l.lx - 4 || x > l.right) return undefined
  for (const r of l.live) if (y >= r.y && y < r.y + Math.min(2, l.rowH)) return r.key
  return l.ended.find(r => r.y === y)?.key
}

export const filterRows = (rows: Row[], query: string): Row[] => {
  const q = query.trim().toLowerCase()
  return q ? rows.filter(r => r.place.toLowerCase().includes(q)) : rows
}

export function moreLine(rest: { connector: string }[]): string {
  const n = (c: string) => rest.filter(r => r.connector === c).length
  return `+ ${rest.length} more · slack ${n('slack')} · email ${n('email')} · / to search`
}

// How a state's string looks. The console animates each kind.
export type Tone = 'red' | 'gold' | 'white' | 'muted' | 'dim'
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

// Where the strings tie on a hand, from the dots that are skin (mask, DW x DH, 1 = skin): the
// fingertip that reaches furthest, up to three fingertips that hang below it, and two knuckles on
// the top edge. Cells, top to bottom (then right to left), so strings to rows in that order do not cross.
export function bodyAnchors(mask: ArrayLike<number>, DW: number, DH: number): [number, number][] {
  const top = new Array<number>(DW).fill(-1), bot = new Array<number>(DW).fill(-1)
  for (let x = 0; x < DW; x++) for (let y = 0; y < DH; y++) if (mask[y * DW + x]) { if (top[x]! < 0) top[x] = y; bot[x] = y }
  const xs = [...top.keys()].filter(x => top[x]! >= 0)
  if (!xs.length) return []
  const x0 = xs[0]!, x1 = xs.at(-1)!, w = x1 - x0
  const pts: [number, number][] = [[x1, Math.round((top[x1]! + bot[x1]!) / 2)]]
  // Fingertips below the reaching one: the lowest points of the right half's lower edge, spaced apart.
  const lowest = xs.filter(x => x >= x0 + w * 0.45 && x < x1 - 4).sort((a, b) => bot[b]! - bot[a]!)
  const tips: number[] = []
  for (const x of lowest) if (bot[x]! > pts[0]![1] + 8 && tips.every(t => Math.abs(t - x) >= 6) && tips.length < 3) tips.push(x)
  for (const x of tips) pts.push([x, bot[x]!])
  for (const f of [0.38, 0.6]) { const x = xs.find(v => v >= x0 + w * f)!; pts.push([x, top[x]! + 1]) }
  const cells = new Map(pts.map(([x, y]) => [`${x >> 1},${y >> 2}`, [x >> 1, y >> 2] as [number, number]]))
  return [...cells.values()].sort((a, b) => a[1] - b[1] || b[0] - a[0])
}

const ccw = (a: readonly number[], b: readonly number[], c: readonly number[]) => (c[1]! - a[1]!) * (b[0]! - a[0]!) - (b[1]! - a[1]!) * (c[0]! - a[0]!)
export const segmentsCross = (p: readonly number[], q: readonly number[], r: readonly number[], s: readonly number[]) => ccw(p, r, s) * ccw(q, r, s) < 0 && ccw(p, q, r) * ccw(p, q, s) < 0

// Which anchor each live row's string ties to: a string runs from its anchor to (tx, row y). One row
// alone takes the reaching fingertip. Several spread across the anchors, each on the nearest one to its
// even share that keeps every string clear of the others. A row past the last anchor gets -1 (its
// string starts below the hand: a point below every anchor, one step lower per extra row, so those
// strings stay in row order and never cross). Returns the tie point of each row.
// ponytail: tries anchors in order of preference and backs up, fine for 6.
export function assignAnchors(anchors: [number, number][], ys: number[], tx: number): [number, number][] {
  const m = anchors.length, n = ys.length
  if (!m) return ys.map(() => [0, 0])
  if (n === 1) return [anchors.reduce((best, a) => (a[0] > best[0] ? a : best), anchors[0]!)]
  const used = Math.min(n, m)
  const ideal = (i: number) => Math.round(i * (m - 1) / (used - 1 || 1))
  const got: number[] = []
  const clear = (i: number, a: number) => got.every((b, j) => segmentsCross(anchors[b]!, [tx, ys[j]!], anchors[a]!, [tx, ys[i]!]) === false)
  const walk = (i: number): boolean => {
    if (i === used) return true
    const order = anchors.map((_, k) => k).sort((a, b) => Math.abs(a - ideal(i)) - Math.abs(b - ideal(i)) || a - b)
    for (const a of order) {
      if (got.includes(a) || !clear(i, a)) continue
      got.push(a)
      if (walk(i + 1)) return true
      got.pop()
    }
    return false
  }
  walk(0)   // always finds a crossing-free choice on the real hands (tested for 1 to 20 rows)
  const wy = Math.max(...anchors.map(a => a[1])) + 1, wx = Math.max(...anchors.map(a => a[0]))
  return Array.from({ length: n }, (_, i) => (i < used ? anchors[got[i]!]! : [wx, wy + i - used] as [number, number]))
}
