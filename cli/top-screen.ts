export let W = 100, H = 38
export function resize(s: { cols: number; rows: number }) { W = s.cols; H = s.rows }
const COL: Record<string, [number, number, number]> = {
  w: [207, 216, 222], W: [240, 245, 248], m: [140, 154, 164], d: [80, 94, 106], k: [36, 46, 56],
  r: [38, 140, 120], R: [111, 240, 208], g: [93, 107, 119], G: [214, 228, 236], f: [52, 64, 76],
  y: [176, 112, 40], Y: [255, 180, 84],
}
export const BG = '\x1b[48;2;10;14;19m'
type Cell = [string, string]
let G: Cell[][] = []
export const clear = () => { G = Array.from({ length: H }, () => Array.from({ length: W }, (): Cell => [' ', 'w'])) }
export const put = (x: number, y: number, s: string, k: string) => {
  x = Math.round(x); y = Math.round(y)
  if (y < 0 || y >= H) return
  for (const ch of s) { if (x >= 0 && x < W) G[y]![x] = [ch, k]; x++ }
}
export const clean = (s: string) => s.replace(/[\x00-\x1f\x7f]/g, ' ')
export const clip = (s: string, n: number) => { const a = [...clean(s)]; return a.length <= n ? a.join('') : `${a.slice(0, Math.max(0, n - 1)).join('')}…` }
export const clamp = (v: number, a = 0, b = 1) => Math.max(a, Math.min(b, v))
export const rnd = (i: number) => { const x = Math.sin(i * 12.9898) * 43758.5453; return x - Math.floor(x) }

export function toText(): string[] {
  return G.map(row => {
    let out = BG, cur = '', buf = ''
    const flush = () => { if (buf) { const [r, g, b] = COL[cur]!; out += `\x1b[38;2;${r};${g};${b}m${buf}`; buf = '' } }
    for (const [c, k] of row) { if (k !== cur) { flush(); cur = k } buf += c }
    flush()
    return `${out}\x1b[0m`
  })
}

export function glitch(t: number) {
  const slot = Math.floor(t / 2600)
  if (rnd(slot) > 0.55 && t % 2600 < 90) {
    const y = Math.floor(rnd(slot * 5) * H), shift = rnd(slot * 7) > 0.5 ? 2 : -2
    const row = G[y]!.slice()
    for (let x = 0; x < W; x++) { const s = row[(x - shift + W) % W]!; G[y]![x] = [s[0], s[1] === 'w' || s[1] === 'W' ? 'r' : s[1]] }
  }
}
