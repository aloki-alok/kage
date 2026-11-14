#!/usr/bin/env node
// kage top: a full-screen console for Kage's sessions, drawn as a loom. Kage (braille, from its avatar)
// holds a string to every live thread; ended threads are one dim row each. It reads the store and the
// transcripts, asks the hub for live state over its socket, and acts only through the hub. It never
// starts a hub. Mouse works on every row.
// l opens the kagelets panel: their state, last report, next run and cost, with keys that act through the hub.
//   kage top           the console (q quits)
//   kage top --once    print one settled frame and exit (COLUMNS and LINES set its size)
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { connect, type Socket } from 'node:net'
import { DIR, ENV_FILE } from './home.ts'
import { DatabaseSync } from 'node:sqlite'
import { ago, boardRows, nextRuns, limitLine, pauseLine, watchingNext, whenLabel, type Live, type Row, type State } from '../core/board.ts'
import { filterRows, hit, layout, moreLine, STRING, type Layout } from '../core/loom.ts'
import { newLines, transcriptLine } from '../core/transcript.ts'
import { HERO_BIG, HERO_SMALL } from '../core/hero.ts'
import { schedulesIn } from '../runtime/store.ts'
import { actionLine, dailyCap, PANEL_KEYS, panelLines, shownState, type PanelAction } from '../core/kagelet-view.ts'
import { kageletRows, type KageletRow } from '../core/kagelets.ts'
import { parseEnv } from '../core/settings.ts'
import { kageletsDir, readKagelets } from '../runtime/kagelets.ts'
import { ledgerText } from '../runtime/ledger.ts'

const HOME = process.env.HOME!
const PROJECT = `${HOME}/.claude/projects/${(process.env.KAGE_CWD || HOME).replace(/[^A-Za-z0-9]/g, '-')}`
const DB = `${DIR}/kage.db`, SOCK = `${DIR}/router.sock`
const ONCE = process.argv.includes('--once')
if (!existsSync(DB)) { console.error(`No ${DB} yet: start Kage first.`); process.exit(1) }
const db = new DatabaseSync(DB, { readOnly: true })
const threadsQuery = db.prepare(`select s.key, s.claude_id as id, coalesce(c.place, s.key) as place, coalesce(c.last_seen, 0) as lastSeen,
  coalesce(c.connector, 'slack') as connector from sessions s left join conversations c using (key)`)

// ---- data

type Step = { at: number; text: string }
type Thread = { key: string; id: string; place: string; lastSeen: number; connector: string }
let live: Live | undefined           // the hub's answer; undefined when it does not answer
let liveAt = 0
let known: Thread[] = []
let schedules: ReturnType<typeof schedulesIn> = []
let next = new Map<string, number>()
let nextAt = 0
let board: Row[] = []                // every thread, in look-first order
let view = { live: [] as Row[], ended: [] as Row[] }   // after the search filter

let boot = Date.now()
let selKey = ''
let hover: string | undefined
let open: string | undefined, openAt = 0
let mode: 'steps' | 'schedules' = 'steps'
let searching = false, query = ''
let message = '', messageAt = 0
let confirmCut = ''
let suspended = false
let L: Layout | undefined            // the layout of the last frame, for mouse hits
let panel = false, pick = 0, confirmRemove = ''
let kagelets: KageletRow[] = [], kageletsAt = 0, kageletsFailed = ''
const CAP = dailyCap(parseEnv(existsSync(ENV_FILE) ? readFileSync(ENV_FILE, 'utf8') : ''))
const KAGELETS = kageletsDir(DIR)

const mtime = (id: string) => { try { return statSync(`${PROJECT}/${id}.jsonl`).mtimeMs } catch { return 0 } }
const idOf = (key: string) => known.find(k => k.key === key)?.id

// What a watching thread waits for comes from the checks its transcript still holds.
const watchCache = new Map<string, { at: number; next: number | undefined }>()
function watchNext(key: string, now: number): number | undefined {
  const c = watchCache.get(key)
  if (c && now - c.at < 30_000) return c.next
  let value: number | undefined
  try { value = watchingNext(readFileSync(`${PROJECT}/${idOf(key)}.jsonl`, 'utf8').split('\n'), now) } catch {}
  watchCache.set(key, { at: now, next: value })
  return value
}

// Each followed thread's latest steps: the transcript tail, then what is added.
type Feed = { file: string; offset: number; steps: Step[]; changed: number }
const feeds = new Map<string, Feed>()
function follow(key: string) {
  const id = idOf(key)
  if (!id) return
  const file = `${PROJECT}/${id}.jsonl`
  let f = feeds.get(key)
  if (!f || f.file !== file) {
    let size = 0
    try { size = statSync(file).size } catch {}
    f = { file, offset: Math.max(0, size - 64_000), steps: [], changed: 0 }
    feeds.set(key, f)
  }
  const r = newLines(file, f.offset)
  f.offset = r.offset
  for (const raw of r.lines) {
    const text = transcriptLine(raw)
    if (!text) continue
    let at = Date.now()
    try { at = Date.parse(JSON.parse(raw).timestamp) || at } catch {}
    for (const t of text.split('\n')) f.steps.push({ at, text: t })
    f.changed = Date.now()
  }
  if (f.steps.length > 300) f.steps = f.steps.slice(-300)
}

// A thread that was live and now is not: its string is cut, and falls as dust.
const prevState = new Map<string, State>()
const sinceState = new Map<string, number>()
const lastY = new Map<string, number>()
let cuts: { y: number; t0: number }[] = []

function rebuild() {
  const rows = filterRows(board, query)
  view = { live: rows.filter(r => r.state !== 'closed'), ended: rows.filter(r => r.state === 'closed') }
}
function refresh(now: number) {
  try { known = threadsQuery.all() as Thread[] } catch {}   // store busy: keep the last read
  if (now - nextAt > 10_000) { schedules = schedulesIn(DB); next = nextRuns(schedules, now); nextAt = now }
  if (now - liveAt > 4_000) live = undefined   // the hub stopped answering
  const nx = new Map(next)
  for (const l of live?.live ?? []) {
    if (l.state !== 'watching') continue
    const w = watchNext(l.key, now)
    if (w !== undefined && w < (nx.get(l.key) ?? Infinity)) nx.set(l.key, w)
  }
  board = boardRows(known, live, new Map(known.map(k => [k.key, mtime(k.id)])), nx, now).rows
  if (live) {
    for (const r of board) {
      const p = prevState.get(r.key)
      if (p && p !== 'closed' && r.state === 'closed' && lastY.has(r.key)) cuts.push({ y: lastY.get(r.key)!, t0: now })
      if (p !== r.state) sinceState.set(r.key, now)
      prevState.set(r.key, r.state)
    }
  }
  cuts = cuts.filter(c => now - c.t0 < 1700)
  if (panel && now - kageletsAt > 3_000) readKageletRows(now)
  rebuild()
  for (const r of view.live) follow(r.key)
  if (open) follow(open)
}

function readKageletRows(now: number) {
  kageletsAt = now
  try { kagelets = kageletRows(readKagelets(KAGELETS), { runs: ledgerText(db, 'runs'), costs: ledgerText(db, 'costs'), reports: ledgerText(db, 'reports'), now }); kageletsFailed = '' } catch (e) { kageletsFailed = `cannot read them: ${(e as Error).message}` }
}

// ---- the hub

let sock: Socket | undefined
let waiters: ((m: any) => void)[] = []   // one per request sent, in order
function hub(): Socket | undefined {
  if (sock && !sock.destroyed) return sock
  if (!existsSync(SOCK)) return undefined
  const s = connect(SOCK)
  let buf = ''
  s.on('data', b => {
    buf += b
    for (let i; (i = buf.indexOf('\n')) >= 0;) {
      let m: any
      try { m = JSON.parse(buf.slice(0, i)) } catch {}
      buf = buf.slice(i + 1)
      if (m) waiters.shift()?.(m)
    }
  })
  s.on('error', () => {})
  s.on('close', () => { if (sock === s) sock = undefined; waiters = [] })
  sock = s
  return s
}
const ask = (m: object) => new Promise<any>(resolve => {
  const s = hub()
  if (!s) return resolve(undefined)
  const t = setTimeout(() => resolve(undefined), 3000)
  waiters.push(r => { clearTimeout(t); resolve(r) })
  s.write(JSON.stringify(m) + '\n')
})
async function pollHub() {
  const r = await ask({ type: 'board' })
  if (r?.type === 'board') { live = r; liveAt = Date.now() }
}

// ---- the screen: a grid of cells, each a character and a colour class

let W = 100, H = 38
const COL: Record<string, [number, number, number]> = {
  w: [244, 241, 234], W: [255, 255, 255], m: [163, 158, 148], d: [86, 82, 100], k: [48, 45, 60],
  r: [208, 20, 30], R: [255, 77, 61], g: [212, 175, 55], G: [255, 215, 94], f: [70, 66, 86],
}
const BG = '\x1b[48;2;15;14;19m'
type Cell = [string, string]
let G: Cell[][] = []
const clear = () => { G = Array.from({ length: H }, () => Array.from({ length: W }, (): Cell => [' ', 'w'])) }
const put = (x: number, y: number, s: string, k: string) => {
  x = Math.round(x); y = Math.round(y)
  if (y < 0 || y >= H) return
  for (const ch of s) { if (x >= 0 && x < W) G[y]![x] = [ch, k]; x++ }
}
const clean = (s: string) => s.replace(/[\x00-\x1f\x7f]/g, ' ')
const clip = (s: string, n: number) => { const a = [...clean(s)]; return a.length <= n ? a.join('') : `${a.slice(0, Math.max(0, n - 1)).join('')}…` }
const clamp = (v: number, a = 0, b = 1) => Math.max(a, Math.min(b, v))
// Deterministic noise, so the start looks the same each run.
const rnd = (i: number) => { const x = Math.sin(i * 12.9898) * 43758.5453; return x - Math.floor(x) }

function toText(): string[] {
  return G.map(row => {
    let out = BG, cur = '', buf = ''
    const flush = () => { if (buf) { const [r, g, b] = COL[cur]!; out += `\x1b[38;2;${r};${g};${b}m${buf}`; buf = '' } }
    for (const [c, k] of row) { if (k !== cur) { flush(); cur = k } buf += c }
    flush()
    return `${out}\x1b[0m`
  })
}

// Kage, whole. During the start it assembles from noise, a bright line sweeps down now and then, and
// the star glints.
const HEROES = { big: HERO_BIG, small: HERO_SMALL }
function drawHero(l: Layout, t: number, since: number) {
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

// A string is the path of cells between two points, each with the box character for its slope.
function path(x0: number, y0: number, x1: number, y1: number): [number, number, string][] {
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

function string(pts: [number, number, string][], kind: string, t: number, i: number, t0: number, since: number) {
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

// A cut string splits at its middle: the star's half draws back, the other half falls as dust.
function cutString(pts: [number, number, string][], t: number, t0: number) {
  const n = pts.length, e = clamp((t - t0) / 1600), mid = Math.floor(n / 2)
  for (let j = 0; j < Math.floor(mid * (1 - e)); j++) put(pts[j]![0], pts[j]![1], pts[j]![2], 'm')
  for (let j = mid; j < n; j++) {
    const fall = e * e * 14 + rnd(j) * e * 4, drift = (rnd(j * 3) - 0.5) * e * 6
    put(pts[j]![0] + drift, pts[j]![1] + fall, e < 0.15 ? pts[j]![2] : '·˙∙.'[j % 4]!, e < 0.4 ? 'r' : e < 0.75 ? 'm' : 'd')
  }
}

// One rare row shifts sideways for a moment.
function glitch(t: number) {
  const slot = Math.floor(t / 2600)
  if (rnd(slot) > 0.55 && t % 2600 < 90) {
    const y = Math.floor(rnd(slot * 5) * H), shift = rnd(slot * 7) > 0.5 ? 2 : -2
    const row = G[y]!.slice()
    for (let x = 0; x < W; x++) { const s = row[(x - shift + W) % W]!; G[y]![x] = [s[0], s[1] === 'w' || s[1] === 'W' ? 'r' : s[1]] }
  }
}

// ---- one frame

const TONE: Record<string, string> = { red: 'R', gold: 'G', white: 'w', muted: 'm', dim: 'd' }
const tz = () => ` ${new Intl.DateTimeFormat([], { timeZoneName: 'short' }).formatToParts(new Date()).find(p => p.type === 'timeZoneName')?.value ?? ''}`
const WORD = ['█▄▀ ▄▀█ █▀▀ █▀▀', '█ █ █▀█ █▄█ ██▄']
function rowLabel(r: Row, now: number) {
  return r.state === 'watching' ? `next ${whenLabel(r.next, now)}` : r.state === 'quiet' ? ago(r.ageMs) : r.label
}

function frame(t: number, since: number): string[] {
  const now = Date.now()
  clear()
  WORD.forEach((l, i) => put(2, 1 + i, l, 'W'))

  const l = layout(W, H, view.live.map(r => r.key), view.ended.map(r => r.key))
  L = l
  // The header ends where the rows end, so it reads as the list's title.
  const clock = live ? `${live.live.length} of ${live.max} strings · ${new Date(now).toTimeString().slice(0, 5)}${tz()}` : existsSync(SOCK) ? 'no live state' : 'hub offline'
  put(l.right - clock.length + 1, 1, clock, 'm')
  const asks = board.filter(r => r.state === 'asking').length
  if (asks) { const a = `◆ ${asks} thread${asks === 1 ? ' waits' : 's wait'} on you`; put(l.right - a.length + 1, 2, a, Math.floor(t / 450) % 2 ? 'G' : 'g') }
  const visible = [...l.live, ...l.ended].map(r => r.key)
  if (!visible.includes(selKey)) selKey = visible[0] ?? ''
  const active = hover ?? selKey
  const byKey = new Map([...view.live, ...view.ended].map(r => [r.key, r]))
  lastY.clear()
  for (const r of l.live) lastY.set(r.key, r.y)

  if (l.hero) drawHero(l, t, since)
  const star = l.star
  const p = l.hero ? clamp((since - 900) / 500) : 1, ease = p * p * (3 - 2 * p)
  const cx = l.hero ? l.hero.x + l.hero.cols / 2 : 0, cy = l.hero ? l.hero.y + l.hero.rows / 2 : 0
  // Every string hangs from the star; it blinks while a thread waits on you.
  if (star && since > 500) put(star.x, star.y, '✦', asks && Math.floor(t / 450) % 2 ? 'G' : 'g')
  l.live.forEach((pos, i) => {
    const r = byKey.get(pos.key)!
    const style = STRING[r.state]
    const hot = pos.key === active
    if (star && since > 500) {
      // The start: the live threads circle Kage, then fly out to their rows as the strings pull tight.
      const a = since / 300 + i * Math.PI * 2 / Math.max(1, l.live.length)
      const ox = cx + Math.cos(a) * l.hero!.cols * 0.54, oy = cy + Math.sin(a) * l.hero!.rows * 0.43
      const nx = ox + (l.lx - 2 - ox) * ease, ny = oy + (pos.y - oy) * ease
      string(path(star.x + 1, star.y, nx, ny), hot ? 'blink' : style.kind, t, i, sinceState.get(pos.key) ?? boot, since)
      put(nx, ny, style.glyph, TONE[style.tone]!)
    } else if (!star) put(l.lx - 2, pos.y, style.glyph, TONE[style.tone]!)
    if (p < 1) return
    const tone = TONE[style.tone]!
    if (hot) put(l.lx - 4, pos.y, '▶', 'R')
    const label = rowLabel(r, now)
    put(l.lx, pos.y, clip(r.place, l.right - l.lx - label.length - 2), hot ? 'G' : 'W')
    put(l.right - label.length, pos.y, label, tone)
    if (l.rowH > 1) {
      const step = feeds.get(pos.key)?.steps.at(-1)
      if (step) put(l.lx, pos.y + 1, clip(step.text, l.right - l.lx), 'm')
    }
  })
  for (const c of cuts) if (star) cutString(path(star.x + 1, star.y, l.lx - 2, c.y), t, c.t0)
  if (p >= 1) {
    if (l.ended.length) put(l.lx - 2, l.sepY, '─'.repeat(Math.max(0, l.right - l.lx + 3)), 'k')
    for (const pos of l.ended) {
      const r = byKey.get(pos.key)!
      const hot = pos.key === active, fresh = r.ageMs < 3_600_000
      put(l.lx - 2, pos.y, '╳', fresh ? 'm' : 'd')
      if (hot) put(l.lx - 4, pos.y, '▶', 'R')
      const age = ago(r.ageMs)
      put(l.lx, pos.y, clip(r.place, l.right - l.lx - age.length - 2), hot ? 'G' : fresh ? 'm' : 'd')
      put(l.right - age.length, pos.y, age, 'd')
    }
    if (l.more > 0 && l.moreY !== undefined) {
      const line = moreLine(view.ended.slice(l.ended.length))
      const x = line.length <= W - l.lx ? l.lx - 2 : 2   // under the rows if it fits, else under Kage
      put(x, l.moreY, clip(line, W - x - 2), 'g')
    }
    if (!l.live.length && !l.ended.length) put(l.lx, l.sepY, query ? 'no thread matches' : 'no threads yet', 'm')
    if (open) detail(l, t, now, byKey)
    if (panel) kageletPanel(now)
  }
  footer(t)
  glitch(t)
  return toText()
}

const STATE_TONE: Record<State, string> = { asking: 'G', working: 'R', watching: 'w', quiet: 'm', starting: 'g', held: 'm', queued: 'g', closed: 'd' }
// The open thread: its live feed from the transcript, the newest line typing in.
function detail(l: Layout, t: number, now: number, byKey: Map<string, Row>) {
  const r = byKey.get(open!)
  if (!r) { open = undefined; return }
  const x0 = l.lx - 3, right = l.right, y0 = 4, y1 = Math.max(y0 + 8, H - 4), w = right - x0
  const k = STATE_TONE[r.state] === 'R' ? 'r' : STATE_TONE[r.state]!
  for (let y = y0; y <= y1; y++) put(x0, y, ' '.repeat(w + 1), 'w')
  put(x0, y0, `┏${'━'.repeat(w - 1)}┓`, k); put(x0, y1, `┗${'━'.repeat(w - 1)}┛`, k)
  for (let y = y0 + 1; y < y1; y++) { put(x0, y, '┃', k); put(right, y, '┃', k) }
  const label = r.state === 'closed' ? `ended ${ago(r.ageMs)} ago` : rowLabel(r, now)
  put(x0 + 2, y0 + 1, clip(`${r.place}`, w - label.length - 6), 'W')
  put(right - label.length - 1, y0 + 1, label, STATE_TONE[r.state]!)
  put(x0 + 2, y0 + 2, '─'.repeat(w - 3), 'k')
  const room = y1 - y0 - 5
  if (mode === 'schedules') {
    const mine = schedules.filter(s => s.key === open)
    if (!mine.length) put(x0 + 3, y0 + 4, 'no schedules for this thread', 'm')
    mine.slice(0, room).forEach((s, i) => {
      const at = nextRuns([s], now).get(s.key)
      put(x0 + 3, y0 + 4 + i, `${s.cron.padEnd(15)} ${(s.recurring ? 'repeats' : 'once').padEnd(8)} ${whenLabel(at, now).padEnd(9)} ${clip(s.prompt.split('\n')[0]!, w - 40)}`, 'm')
    })
  } else {
    const f = feeds.get(open!)
    const steps = (f?.steps ?? []).slice(-Math.max(1, room))
    if (!steps.length) put(x0 + 3, y0 + 4, 'nothing in its transcript yet', 'm')
    const typed = (f?.changed ?? 0) > openAt ? Math.max(0, Math.floor((now - f!.changed) / 22)) : Infinity
    steps.forEach((s, i) => {
      const y = y0 + 4 + i
      const m = /^(\S+)\s+(.*)$/.exec(s.text)
      const tag = m ? m[1]! : '', text = clean(m ? m[2]! : s.text)
      const newest = i === steps.length - 1
      const shown = newest ? Math.min(text.length, typed) : text.length
      const maxw = right - x0 - 22
      put(x0 + 3, y, new Date(s.at).toTimeString().slice(0, 8), 'd')
      put(x0 + 12, y, tag.padEnd(7), tag === 'reply' ? 'R' : tag === 'says' ? 'w' : 'g')
      put(x0 + 19, y, clip(text.slice(0, shown), maxw), tag === 'reply' ? 'W' : 'm')
      if (newest && shown < text.length) put(x0 + 19 + Math.min(shown, maxw), y, '▌', 'R')
    })
  }
  const keys = `a attach   x cut   s ${mode === 'steps' ? 'schedules' : 'steps'}   esc close`
  put(right - keys.length - 2, y1 - 1, keys, 'm')
}

const SHOWN_TONE: Record<string, string> = { running: 'w', paused: 'm', broken: 'R', 'over cap': 'G' }
// The kagelets: two lines each, the state line and its last report, across the whole width.
function kageletPanel(now: number) {
  const x0 = 2, right = W - 3, y0 = 4, y1 = H - 3, w = right - x0
  for (let y = y0; y <= y1; y++) put(0, y, ' '.repeat(W), 'w')
  put(x0, y0, `┏${'━'.repeat(w - 1)}┓`, 'g'); put(x0, y1, `┗${'━'.repeat(w - 1)}┛`, 'g')
  for (let y = y0 + 1; y < y1; y++) { put(x0, y, '┃', 'g'); put(right, y, '┃', 'g') }
  const head = clip(kageletsFailed || (live ? `cap $${CAP.toFixed(2)} a day each` : 'hub offline: the keys need it'), w - 20)
  put(x0 + 2, y0 + 1, `Kagelets (${kagelets.length})`, 'W'); put(right - head.length - 1, y0 + 1, head, live && !kageletsFailed ? 'm' : 'R')
  put(x0 + 2, y0 + 2, '─'.repeat(w - 3), 'k')
  if (!kagelets.length) put(x0 + 3, y0 + 4, 'no kagelets yet', 'm')
  pick = clamp(pick, 0, Math.max(0, kagelets.length - 1))
  const fit = Math.max(1, Math.floor((y1 - y0 - 5) / 2)), from = Math.max(0, pick - fit + 1)
  panelLines(kagelets, now, CAP).slice(from, from + fit).forEach((line, i) => {
    const r = kagelets[from + i]!, y = y0 + 3 + i * 2, hot = from + i === pick
    if (hot) put(x0 + 1, y, '▶', 'R')
    put(x0 + 3, y, clip(line.main, w - 4), hot ? 'G' : SHOWN_TONE[shownState(r, CAP)]!)
    put(x0 + 5, y + 1, clip(line.report, w - 6), 'm')
  })
  const keys = 'r run now   p pause   u resume   x remove   esc close'
  put(right - keys.length - 2, y1 - 1, keys, 'm')
}

function footer(t: number) {
  const y = H - 1
  if (confirmRemove) {
    put(2, y, clip(`Remove ${confirmRemove}? Its file and its schedule go.`, W - 22), 'G'); put(W - 19, y, 'y', 'r'); put(W - 17, y, 'remove', 'm'); put(W - 8, y, 'n', 'r'); put(W - 6, y, 'keep', 'm')
    return
  }
  if (confirmCut) {
    const place = known.find(k => k.key === confirmCut)?.place ?? ''
    put(2, y, clip(`Cut ${place}? It spins up again on its next task.`, W - 20), 'G'); put(W - 16, y, 'y', 'r'); put(W - 14, y, 'cut', 'm'); put(W - 8, y, 'n', 'r'); put(W - 6, y, 'keep', 'm')
    return
  }
  if (searching) { put(2, y, `/ ${query}${Math.floor(t / 400) % 2 ? '▌' : ' '}`, 'G'); put(W - 28, y, 'enter keep   esc clear', 'm'); return }
  if (message && Date.now() - messageAt < 5000) { put(2, y, clip(message, W - 4), 'G'); return }
  let x = 2
  const parts: [string, string][] = [['↑↓', 'pick'], ['⏎', 'open'], ['a', 'attach'], ['x', 'cut'], ['s', 'schedules'], ['l', 'kagelets'], ['/', query ? `search: ${query}` : 'search'], ['q', 'quit']]
  for (const [k, w] of parts) {
    if (x + k.length + w.length + 1 > W - 2) break
    put(x, y, k, 'r'); put(x + k.length + 1, y, w, 'm'); x += k.length + w.length + 5
  }
}

// ---- running

const size = () => ({ cols: Number(process.env.COLUMNS) || process.stdout.columns || 80, rows: Number(process.env.LINES) || process.stdout.rows || 24 })
const intro = () => (view.live.length && L?.hero ? Date.now() - boot : 1e9)
function draw() {
  if (suspended) return
  ;({ cols: W, rows: H } = size())
  const now = Date.now()
  if (now - lastRefresh > 1000) { lastRefresh = now; refresh(now) }
  const text = frame(now, intro())
  process.stdout.write(`\x1b[H${text.map((l, i) => `\x1b[${i + 1};1H${l}`).join('')}`)
}
let lastRefresh = 0

if (ONCE) {
  await pollHub()
  ;({ cols: W, rows: H } = size())
  refresh(Date.now())
  frame(boot, 1e9)           // lays out, so the selection exists
  // Piped (a script, a Kage session): one plain line per open thread instead of the picture.
  if (process.stdout.isTTY) console.log(toText().join('\n'))
  else for (const r of board.filter(r => r.state !== 'closed')) console.log([r.label, r.place, r.next ? `next ${whenLabel(r.next, Date.now())}` : `${ago(r.ageMs)} ago`].join('\t'))
  if (live?.paused) console.log(pauseLine(live.paused))
  const cost = limitLine(live?.limitCounts)
  if (cost) console.log(cost)
  process.exit(0)
}

if (!process.stdin.isTTY || !process.stdout.isTTY) { console.error('kage top needs a terminal. Use --once to print one frame.'); process.exit(1) }

// 1049: the alternate screen. 1003 and 1006: mouse motion and clicks, as SGR sequences.
const ENTER = '\x1b[?1049h\x1b[?25l\x1b[?1003h\x1b[?1006h', LEAVE = '\x1b[?1006l\x1b[?1003l\x1b[?25h\x1b[?1049l\x1b[0m'
function enter() { process.stdin.setRawMode(true); process.stdin.resume(); process.stdout.write(`${ENTER}${BG}\x1b[2J`) }
function leave() { try { process.stdin.setRawMode(false) } catch {} process.stdout.write(LEAVE) }
let left = false
const quit = (code = 0) => { if (!left) { left = true; leave() } process.exit(code) }
process.on('uncaughtException', e => { leave(); console.error(e); process.exit(1) })
process.on('unhandledRejection', e => { leave(); console.error(e); process.exit(1) })
for (const sig of ['SIGTERM', 'SIGHUP', 'SIGINT'] as const) process.on(sig, () => quit())
process.stdout.on('resize', () => { process.stdout.write(`${BG}\x1b[2J`); draw() })

const say = (m: string) => { message = m; messageAt = Date.now() }
const CUT_WHY = { closed: 'it is not running', starting: 'it is still starting', busy: 'it is working', asking: 'it waits on your approval' } as const
// Attach takes any running session at once (it stops a turn, like Esc); only one terminal may hold it.
const ATTACH_WHY: Partial<Record<State, string>> = { held: 'it is already open in a terminal' }
const placeOf = (key: string) => known.find(k => k.key === key)?.place ?? key

async function cut(key: string) {
  const r = await ask({ type: 'stop', key })
  if (!r) say(`Cannot cut ${placeOf(key)}: the hub does not answer.`)
  else if (r.ok) say(`Cut ${placeOf(key)}. It spins up again on its next task.`)
  // The hub says 'busy' for a watching session too; the row knows which it is.
  else say(`Cannot cut ${placeOf(key)}: ${r.refused === 'busy' && live?.live.find(l => l.key === key)?.state === 'watching' ? 'a timed check is running in it' : CUT_WHY[r.refused as keyof typeof CUT_WHY] ?? r.refused}.`)
  await pollHub()
  refresh(Date.now())
}

function attach(r: Row) {
  const why = ATTACH_WHY[r.state]
  if (!live) return say('Cannot attach: the hub is not running.')
  if (why) return say(`Cannot attach to ${r.place}: ${why}.`)
  suspended = true
  leave()
  const done = spawnSync(process.execPath, [new URL('./attach.ts', import.meta.url).pathname, r.key], { stdio: 'inherit' })
  const back = () => { suspended = false; enter(); draw() }
  if (done.error) say(`Cannot start attach: ${done.error.message}`)
  if (done.status || done.error) {
    process.stderr.write('\nPress any key to go back to the console.')
    process.stdin.setRawMode(true)
    process.stdin.once('data', back)
  } else back()
}

async function act(action: PanelAction, name: string) {
  say(actionLine(await ask({ type: 'kagelet', action, name }), !!live))
  readKageletRows(Date.now())
}

const target = () => open ?? hover ?? selKey
const rowOf = (key: string) => board.find(r => r.key === key)
function openThread(key: string) { open = key; selKey = key; openAt = Date.now(); mode = 'steps'; follow(key) }

// Input: SGR mouse reports (button;column;row, 1-based), arrow keys, Esc, or one character.
const TOKEN = /\x1b\[<(\d+);(\d+);(\d+)([Mm])|\x1b\[[A-D]|\x1b|[\s\S]/gu
async function onKey(k: string) {
  const list = [...(L?.live ?? []), ...(L?.ended ?? [])].map(r => r.key)
  const at = Math.max(0, list.indexOf(selKey))
  if (confirmCut) { const key = confirmCut; confirmCut = ''; if (k === 'y') await cut(key); return }
  if (confirmRemove) { const name = confirmRemove; confirmRemove = ''; if (k === 'y') await act('remove', name); return }
  if (panel) {
    const name = kagelets[pick]?.name, action = PANEL_KEYS[k]
    if (k === 'q' || k === '\x03') quit()
    else if (k === '\x1b' || k === 'l') panel = false
    else if (k === '\x1b[A' || k === 'k') pick = Math.max(0, pick - 1)
    else if (k === '\x1b[B' || k === 'j') pick = Math.min(kagelets.length - 1, pick + 1)
    else if (action && name) { if (action === 'remove') confirmRemove = name; else await act(action, name) }
    return
  }
  if (searching) {
    if (k === '\x1b') { query = ''; searching = false } else if (k === '\r') searching = false
    else if (k === '\x7f') query = query.slice(0, -1)
    else if (k >= ' ' && k.length === 1) query += k
    rebuild(); return
  }
  hover = undefined
  if (k === 'q' || k === '\x03') quit()
  else if (k === '\x1b') { if (open) open = undefined; else if (query) { query = ''; rebuild() } }
  else if (k === '\x1b[A' || k === 'k') selKey = list[Math.max(0, at - 1)] ?? selKey
  else if (k === '\x1b[B' || k === 'j') selKey = list[Math.min(list.length - 1, at + 1)] ?? selKey
  else if (k === '\r') { if (selKey) openThread(selKey) }
  else if (k === '/') { searching = true; open = undefined }
  else if (k === 's') { if (!open && selKey) openThread(selKey); mode = mode === 'steps' ? 'schedules' : 'steps' }
  else if (k === 'x' && target()) confirmCut = target()
  else if (k === 'a') { const r = rowOf(target()); if (r) attach(r) }
  else if (k === 'l') { panel = true; open = undefined; readKageletRows(Date.now()) }
}
function onMouse(b: number, x: number, y: number, press: boolean) {
  if (!L || intro() < 4100 || panel) return
  const over = (open && x >= L.lx - 3 && y >= 4) ? undefined : hit(L, x - 1, y - 1)
  if (b === 35 || b === 32) { hover = over; return }       // motion
  if (b === 0 && press) { if (over) openThread(over); else if (!(open && x >= L.lx - 3)) open = undefined }
}

process.stdin.on('data', async b => {
  if (suspended) return
  if (Date.now() - boot < 4100) boot = Date.now() - 4100   // any key or click ends the start animation
  for (const m of b.toString().matchAll(TOKEN)) {
    if (m[1] !== undefined) onMouse(Number(m[1]), Number(m[2]), Number(m[3]), m[4] === 'M')
    else await onKey(m[0])
  }
  draw()
})
enter()
await pollHub()
refresh(Date.now())
draw()
setInterval(() => { void pollHub() }, 1000)
setInterval(draw, 70)
