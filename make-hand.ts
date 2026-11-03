#!/usr/bin/env node
// Regenerates hand.ts: the hand of God from Michelangelo's Creation of Adam, as braille, with the
// fingertip anchors the strings are tied to.   node make-hand.ts   (macOS: uses `sips`)
// Source: docs/god-hand.jpg, a crop of Wikimedia Commons "File:Michelangelo_-_Creation_of_Adam_(cropped).jpg",
// public domain. Commons tags (checked 2026-11-03): PD-Art (PD-old-auto-expired), PD-old-100-expired, CC-PD-Mark. No attribution required: https://commons.wikimedia.org/wiki/File:Michelangelo_-_Creation_of_Adam_(cropped).jpg
// The crop is stored mirrored, so the hand reaches right. Steps: cut the plaster away (flood fill from the edges), levels and an
// unsharp mask inside the hand, Floyd-Steinberg dithering, 2x4 dots per braille cell. The arm fades
// out on the left so it melts into Kage. A cell the hand covers but leaves dark is a blank braille
// (U+2800), which clears Kage's dots under it.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { bodyAnchors } from './core/loom.ts'

const SOURCE = new URL('./docs/god-hand.jpg', import.meta.url).pathname
const SIZES = { big: [40, 14], small: [28, 10] } as const
const FADE = 12                          // dots over which the arm fades in from the left
const WORK = [256, 224] as const         // the picture is read at this size, then averaged down
const RX = 30, RY = 26, RW = 222         // the part of it that holds the hand

function work() {
  const dir = mkdtempSync(`${tmpdir()}/kage-hand-`)
  execFileSync('sips', ['-z', String(WORK[1]), String(WORK[0]), '-s', 'format', 'bmp', SOURCE, '--out', `${dir}/w.bmp`], { stdio: 'ignore' })
  const b = readFileSync(`${dir}/w.bmp`)
  const at = b.readUInt32LE(10), w = b.readInt32LE(18), hh = b.readInt32LE(22), h = Math.abs(hh), bpp = b.readUInt16LE(28)
  const stride = Math.floor((bpp * w + 31) / 32) * 4
  const lum = new Float32Array(w * h), sat = new Float32Array(w * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = at + (hh > 0 ? h - 1 - y : y) * stride + x * (bpp / 8)
    const r = b[o + 2]!, g = b[o + 1]!, bl = b[o]!
    lum[y * w + x] = 0.3 * r + 0.59 * g + 0.11 * bl
    const mx = Math.max(r, g, bl)
    sat[y * w + x] = mx ? (mx - Math.min(r, g, bl)) / mx : 0
  }
  const box = (a: Float32Array, r: number) => {
    const o = new Float32Array(w * h)
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let s = 0, n = 0
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) { const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue; s += a[yy * w + xx]!; n++ }
      o[y * w + x] = s / n
    }
    return o
  }
  const bl = box(lum, 3), bs = box(sat, 3)
  // The plaster is pale and grey; the skin is warmer. Fill from the edges through plaster only.
  const mask = new Uint8Array(w * h).fill(1), seen = new Uint8Array(w * h), stack: number[] = []
  for (let x = 0; x < w; x++) stack.push(x, (h - 1) * w + x)
  for (let y = 0; y < h; y++) stack.push(y * w, y * w + w - 1)
  while (stack.length) {
    const i = stack.pop()!
    if (seen[i]) continue
    seen[i] = 1
    if (!(bs[i]! < 0.2 && bl[i]! > 150)) continue
    mask[i] = 0
    const x = i % w, y = (i / w) | 0
    if (x > 0) stack.push(i - 1); if (x < w - 1) stack.push(i + 1); if (y > 0) stack.push(i - w); if (y < h - 1) stack.push(i + w)
  }
  // The red cloak at the bottom left of the crop is not part of the hand.
  for (let y = 95; y < h; y++) for (let x = 0; x < 26; x++) mask[y * w + x] = 0
  return { w, lum, mask }
}

const BITS = [[0, 0, 1], [0, 1, 2], [0, 2, 4], [1, 0, 8], [1, 1, 16], [1, 2, 32], [0, 3, 64], [1, 3, 128]] as const

function braille(src: ReturnType<typeof work>, cols: number, rows: number) {
  const DW = cols * 2, DH = rows * 4, RH = RW * DH / DW, FX = RW / DW, FY = RH / DH
  const L = new Float32Array(DW * DH), M = new Float32Array(DW * DH)
  for (let y = 0; y < DH; y++) for (let x = 0; x < DW; x++) {
    let s = 0, m = 0, n = 0
    for (let yy = RY + Math.floor(y * FY); yy < RY + Math.floor((y + 1) * FY); yy++) for (let xx = RX + Math.floor(x * FX); xx < RX + Math.floor((x + 1) * FX); xx++) {
      const i = yy * src.w + xx
      s += src.lum[i]! * src.mask[i]!; m += src.mask[i]!; n++
    }
    M[y * DW + x] = m / n > 0.5 ? 1 : 0
    L[y * DW + x] = m ? s / m : 0
  }
  const vals = [...L].filter((_, i) => M[i]).sort((a, b) => a - b)
  const lo = vals[Math.floor(vals.length * 0.03)]!, hi = vals[Math.floor(vals.length * 0.97)]!
  const V0 = L.map((v, i) => (M[i] ? Math.min(1, Math.max(0, (v - lo) / (hi - lo))) : 0))
  // Unsharp mask inside the hand: separates knuckles and finger folds.
  const BR = 4, V = new Float32Array(DW * DH)
  for (let y = 0; y < DH; y++) for (let x = 0; x < DW; x++) {
    const i = y * DW + x
    if (!M[i]) continue
    let s = 0, n = 0
    for (let dy = -BR; dy <= BR; dy++) for (let dx = -BR; dx <= BR; dx++) { const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= DW || yy >= DH || !M[yy * DW + xx]) continue; s += V0[yy * DW + xx]!; n++ }
    const v = Math.pow(Math.min(1, Math.max(0, V0[i]! + 1.8 * (V0[i]! - s / n) - 0.15)), 1.3)
    V[i] = v * Math.min(1, x / FADE)
  }
  // Floyd-Steinberg
  const a = Float32Array.from(V), lit = new Uint8Array(DW * DH)
  for (let y = 0; y < DH; y++) for (let x = 0; x < DW; x++) {
    const i = y * DW + x, old = a[i]!, nw = old >= 0.5 ? 1 : 0
    lit[i] = M[i] ? nw : 0
    const e = old - nw
    if (x + 1 < DW) a[i + 1]! += e * 7 / 16
    if (y + 1 < DH) { if (x > 0) a[i + DW - 1]! += e * 3 / 16; a[i + DW]! += e * 5 / 16; if (x + 1 < DW) a[i + DW + 1]! += e * 1 / 16 }
  }
  const chars: string[] = []
  for (let r = 0; r < rows; r++) {
    let line = ''
    for (let c = 0; c < cols; c++) {
      let bits = 0, solid = 0
      for (const [dx, dy, bit] of BITS) { const i = (r * 4 + dy) * DW + c * 2 + dx; if (lit[i]) bits |= bit; if (M[i]) solid++ }
      line += bits ? String.fromCharCode(0x2800 + bits) : solid >= 5 && c * 2 >= FADE ? '⠀' : ' '
    }
    chars.push(line)
  }
  // The hand's shape in dots, for the anchors: which dots are skin.
  return { chars, mask: M, DW, DH }
}

const src = work()
const out = Object.entries(SIZES).map(([name, [c, r]]) => {
  const art = braille(src, c, r)
  const anchors = bodyAnchors(art.mask, art.DW, art.DH)
  return `export const HAND_${name.toUpperCase()} = ${JSON.stringify({ chars: art.chars, anchors }, null, 1)}\n`
})
writeFileSync(new URL('./hand.ts', import.meta.url), `// Generated by make-hand.ts from docs/god-hand.jpg (public domain, see that script). Do not edit: run \`node make-hand.ts\`.\n// chars: braille per cell. anchors: the cells the strings are tied to, top to bottom.\n${out.join('')}`)
