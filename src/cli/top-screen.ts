import type { Rect } from '../core/top-layout.ts'

export let W = 100, H = 38
export function resize(s: { cols: number; rows: number }) { W = s.cols; H = s.rows }

const COL: Record<string, [number, number, number]> = {
  ink: [212, 219, 225], hi: [244, 247, 249], mid: [134, 147, 160], dim: [75, 87, 99], line: [42, 52, 64],
  work: [45, 190, 160], you: [240, 160, 64], ok: [127, 207, 142], bad: [229, 103, 90], bg: [11, 14, 18],
}
const FILL: Record<string, [number, number, number]> = { '': COL.bg!, sel: COL.work!, ask: COL.you!, bar: [22, 28, 35], modal: [18, 24, 32], btn: [31, 39, 49] }
export const BG = `\x1b[48;2;${COL.bg!.join(';')}m`

type Cell = { ch: string; k: string; bg: string }
let G: Cell[][] = []
export const clear = () => { G = Array.from({ length: H }, () => Array.from({ length: W }, (): Cell => ({ ch: ' ', k: 'ink', bg: '' }))) }

export function put(x: number, y: number, s: string, k: string, bg?: string) {
  x = Math.round(x); y = Math.round(y)
  if (y < 0 || y >= H) return
  for (const ch of s) {
    if (x >= 0 && x < W) G[y]![x] = { ch, k, bg: bg ?? G[y]![x]!.bg }
    x++
  }
}

export function fill(r: Rect, bg: string) {
  for (let y = Math.max(0, r.y0); y <= Math.min(H - 1, r.y1); y++)
    for (let x = Math.max(0, r.x0); x <= Math.min(W - 1, r.x1); x++) G[y]![x] = { ch: ' ', k: 'ink', bg }
}

export function paint(r: Rect, bg: string) {
  for (let y = Math.max(0, r.y0); y <= Math.min(H - 1, r.y1); y++)
    for (let x = Math.max(0, r.x0); x <= Math.min(W - 1, r.x1); x++) G[y]![x]!.bg = bg
}

export const clean = (s: string) => s.replace(/[\x00-\x1f\x7f]/g, ' ')
export const clip = (s: string, n: number) => { const a = [...clean(s)]; return n <= 0 ? '' : a.length <= n ? a.join('') : `${a.slice(0, Math.max(0, n - 1)).join('')}…` }
export const clamp = (v: number, a = 0, b = 1) => Math.max(a, Math.min(b, v))

export function toText(): string[] {
  return G.map(row => {
    let out = '', cur = '', buf = ''
    const flush = () => {
      if (!buf) return
      const [k, bg] = cur.split('|') as [string, string]
      out += `\x1b[48;2;${FILL[bg]!.join(';')}m\x1b[38;2;${COL[k]!.join(';')}m${buf}`
      buf = ''
    }
    for (const c of row) { const key = `${c.k}|${c.bg}`; if (key !== cur) { flush(); cur = key } buf += c.ch }
    flush()
    return `${out}\x1b[0m`
  })
}
