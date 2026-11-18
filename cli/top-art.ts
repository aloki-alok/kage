import { HERO_BIG, HERO_SMALL } from '../core/hero.ts'
import type { Layout } from '../core/loom.ts'
import { clamp, put, rnd } from './top-screen.ts'

const HEROES = { big: HERO_BIG, small: HERO_SMALL }
export function drawHero(l: Layout, t: number, since: number, boot: number) {
  const h = HEROES[l.mode as 'big' | 'small']
  const R = h.chars.length, C = h.chars[0]!.length
  const scan = ((t - boot) / 70) % (R * 6)
  for (let r = 0; r < R; r++) for (let c = 0; c < C; c++) {
    let k = h.cls[r]![c]!
    const ch = h.chars[r]![c]!
    if (since < rnd(r * C + c + 1) * 500 + r * 10) {
      if (rnd(r * 97 + c * 13 + Math.floor(t / 60)) > 0.55) put(l.hero!.x + c, l.hero!.y + r, String.fromCharCode(0x2800 + Math.floor(rnd(c * r + t / 50) * 255)), 'f')
      continue
    }
    if (Math.abs(r - scan) < 0.6 && ch !== ' ') k = k === 'r' ? 'R' : 'W'
    else if (k === 'g' && rnd(r * 7 + c + Math.floor(t / 300)) > 0.7) k = 'G'
    if (ch !== ' ') put(l.hero!.x + c, l.hero!.y + r, ch, k)
  }
}

export function path(x0: number, y0: number, x1: number, y1: number): [number, number, string][] {
  x0 = Math.round(x0); y0 = Math.round(y0); x1 = Math.round(x1); y1 = Math.round(y1)
  const pts: [number, number, string][] = []
  const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1
  let err = dx + dy, x = x0, y = y0
  for (;;) {
    const px = x, py = y
    if (x === x1 && y === y1) { pts.push([x, y, pts.length ? pts[pts.length - 1]![2] : '│']); break }
    const e2 = 2 * err
    let mx = 0, my = 0
    if (e2 >= dy) { err += dy; x += sx; mx = sx }
    if (e2 <= dx) { err += dx; y += sy; my = sy }
    pts.push([px, py, mx && my ? (mx === my ? '╲' : '╱') : my ? '│' : '─'])
  }
  return pts
}
const QUIET: Record<string, string> = { '│': '┊', '─': '┄', '╲': '·', '╱': '·' }

export function string(pts: [number, number, string][], kind: string, t: number, i: number, t0: number, since: number) {
  const n = pts.length
  const grown = Math.floor(clamp((since - 500 - i * 60) / 300) * n)
  if (kind === 'grow') {
    const m = Math.floor(clamp((t - t0) / 1800) * n)
    for (let j = 0; j < m; j++) put(pts[j]![0], pts[j]![1], pts[j]![2], 'g')
    if (m < n && m > 0) put(pts[m]![0], pts[m]![1], '✦', 'G')
    return
  }
  for (let j = 0; j < Math.min(grown, n); j++) {
    let [x, y, ch] = pts[j]!, k = 'm'
    if (kind === 'pulse') {
      k = 'r'
      const p = ((t / 45) + i * 7) % (n + 8)
      if (j === Math.floor(p)) { ch = '●'; k = 'R' } else if (j === Math.floor(p) - 1) { ch = '•'; k = 'R' } else if (j === Math.floor(p) - 2) k = 'R'
    } else if (kind === 'blink') {
      k = Math.floor(t / 450) % 2 ? 'G' : 'g'
      if (j === Math.floor(n / 2)) ch = '◆'
    } else if (kind === 'drift') {
      k = 'w'
      if (j === Math.floor(((t / 110) + i * 11) % (n * 3))) { ch = '∘'; k = 'W' }
    } else { ch = QUIET[ch] ?? ch; k = 'm' }
    put(x, y, ch, k)
  }
}

export function cutString(pts: [number, number, string][], t: number, t0: number) {
  const n = pts.length, e = clamp((t - t0) / 1600), mid = Math.floor(n / 2)
  for (let j = 0; j < Math.floor(mid * (1 - e)); j++) put(pts[j]![0], pts[j]![1], pts[j]![2], 'm')
  for (let j = mid; j < n; j++) {
    const fall = e * e * 14 + rnd(j) * e * 4, drift = (rnd(j * 3) - 0.5) * e * 6
    put(pts[j]![0] + drift, pts[j]![1] + fall, e < 0.15 ? pts[j]![2] : '·˙∙.'[j % 4]!, e < 0.4 ? 'r' : e < 0.75 ? 'm' : 'd')
  }
}
