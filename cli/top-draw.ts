import { ago, whenLabel, type Row } from '../core/board.ts'
import type { Schedule } from '../core/cron.ts'
import type { KageletRow } from '../core/kagelets/kagelet.ts'
import { runLine, shownState, type Run } from '../core/kagelets/view.ts'
import { activityBins, bars, listRows, MARK, perHour, screen, spinner, type Rect, type Screen } from '../core/top-layout.ts'
import { clean, clear, clip, fill, H, paint, put, W } from './top-screen.ts'

export type Tab = 'threads' | 'kagelets' | 'schedules'
export const TABS: Tab[] = ['threads', 'kagelets', 'schedules']
export type Step = { at: number; text: string }
export type View = {
  now: number; t: number; since: number
  version?: string; channels: { name: string; up: boolean | undefined }[]; hubUp: boolean; upSec?: number; spentToday: number; slots?: { used: number; max: number }
  rows: Row[]; nowLine: (key: string) => string | undefined
  ask?: { place: string; what: string }
  tab: Tab; focus: 'list' | 'feed'; selKey: string; open?: string; mode: 'steps' | 'schedules'
  feed: Step[]; typed: number; threadSpend: number
  schedules: Schedule[]; nextOf: (s: Schedule) => number | undefined; placeOf: (key: string) => string
  kagelets: KageletRow[]; pick: number; runs: Run[]; cap?: number
  turns: number[]; costs: { at: number; usd: number }[]
  query: string; searching: boolean
  confirm?: { title: string; body: string[]; yes: string }
  message?: string; paused?: string
}
export type Hits = { rows: { key: string; y: number }[]; list: Rect; tabs: { tab: Tab; x0: number; x1: number; y: number }[] }

const TONE = { work: 'work', you: 'you', ink: 'ink', mid: 'mid', dim: 'dim' } as const

function pane(r: Rect, focus: boolean, title: string[], active: number, right?: string, hints?: [string, string][], numbered = false): { tab: number; x0: number; x1: number }[] {
  const k = focus ? 'work' : 'line'
  put(r.x0, r.y0, `╭${'─'.repeat(r.x1 - r.x0 - 1)}╮`, k)
  put(r.x0, r.y1, `╰${'─'.repeat(r.x1 - r.x0 - 1)}╯`, k)
  for (let y = r.y0 + 1; y < r.y1; y++) { put(r.x0, y, '│', k); put(r.x1, y, '│', k) }
  const spots: { tab: number; x0: number; x1: number }[] = []
  let x = r.x0 + 2
  title.forEach((t, i) => {
    const label = numbered ? `${'¹²³'[i]}${t}` : t
    put(x, r.y0, ` ${label} `, i === active ? 'hi' : 'dim')
    spots.push({ tab: i, x0: x, x1: x + label.length + 1 })
    x += label.length + 2
    if (i < title.length - 1) put(x, r.y0, '│', k)
    x += 1
  })
  if (right && x + right.length + 4 < r.x1) put(r.x1 - right.length - 3, r.y0, ` ${right} `, 'mid')
  if (hints?.length) {
    let hx = r.x1 - 2 - hints.reduce((n, [a, b]) => n + a.length + b.length + 3, 0)
    for (const [a, b] of hints) { put(hx, r.y1, ` ${a}`, focus ? 'work' : 'mid'); put(hx + a.length + 1, r.y1, ` ${b} `, 'dim'); hx += a.length + b.length + 3 }
  }
  return spots
}

function header(v: View) {
  fill({ x0: 0, y0: 0, x1: W - 1, y1: 0 }, 'bar')
  let x = 1
  const seg = (s: string, k: string) => { put(x, 0, s, k, 'bar'); x += [...s].length + 3 }
  seg(' kage', 'hi'); x -= 2; seg(v.version ?? '', 'dim')
  if (!v.hubUp) { put(x, 0, '●', 'bad', 'bar'); x += 2; seg('hub offline', 'mid') }
  else {
    for (const c of v.channels) { put(x, 0, '●', c.up === undefined ? 'you' : c.up ? 'ok' : 'bad', 'bar'); put(x + 2, 0, c.name, 'mid', 'bar'); x += c.name.length + 4 }
    x += 1
  }
  if (v.upSec !== undefined) seg(`up ${ago(v.upSec * 1000)}`, 'mid')
  seg(`$${v.spentToday.toFixed(2)} today`, 'mid')
  if (v.slots) {
    put(x, 0, 'slots ', 'mid', 'bar'); x += 6
    put(x, 0, '■'.repeat(v.slots.used), 'work', 'bar'); put(x + v.slots.used, 0, '□'.repeat(Math.max(0, v.slots.max - v.slots.used)), 'dim', 'bar')
    x += v.slots.max + 1; seg(`${v.slots.used}/${v.slots.max}`, 'mid')
  }
  const clock = new Date(v.now).toTimeString().slice(0, 5)
  put(W - clock.length - 2, 0, clock, 'mid', 'bar')
}

function banner(v: View, y: number) {
  const on = Math.floor(v.t / 800) % 2 === 0
  fill({ x0: 0, y0: y, x1: W - 1, y1: y }, on ? 'ask' : 'bar')
  const keys = '⏎ open'
  put(2, y, clip(`◆ ${v.ask!.place} asks you: ${v.ask!.what}`, W - keys.length - 8), on ? 'bg' : 'you')
  put(W - keys.length - 3, y, keys, on ? 'bg' : 'you')
}

function threadTable(v: View, r: Rect, focus: boolean): { key: string; y: number }[] {
  const x1 = r.x1, from = x1 - r.x0 >= 80
  const cx = { place: r.x0 + 4, from: r.x0 + 23, state: from ? r.x0 + 32 : r.x0 + 23, now: from ? r.x0 + 44 : r.x0 + 35 }
  const nowW = Math.max(8, x1 - cx.now - 6)
  const head = r.y0 + 1
  let y0 = head + 1
  if (v.searching || v.query) { put(r.x0 + 2, head, '/', 'work'); put(r.x0 + 4, head, `${v.query}${v.searching && Math.floor(v.t / 450) % 2 ? '▌' : ''}`, 'hi'); y0 = head + 2 }
  const cols: [number, string][] = [[cx.place, 'PLACE'], ...(from ? [[cx.from, 'FROM']] as [number, string][] : []), [cx.state, 'STATE'], [cx.now, 'NOW']]
  if (!(v.searching || v.query)) { for (const [x, h] of cols) put(x, head, h, 'dim'); put(x1 - 4, head, 'AGE', 'dim') }
  const room = r.y1 - y0
  const shown = listRows(v.rows.map(x => x.key), v.selKey, room)
  const byKey = new Map(v.rows.map(x => [x.key, x]))
  if (!v.rows.length) put(r.x0 + 4, y0, v.query ? 'no thread matches' : 'no threads yet', 'mid')
  for (const s of shown) {
    const row = byKey.get(s.key)!, y = y0 + s.y, on = s.key === v.selKey
    const m = MARK[row.state]
    const fg = (k: string) => (on ? (focus ? 'bg' : 'hi') : k)
    if (on) paint({ x0: r.x0 + 1, y0: y, x1: x1 - 1, y1: y }, focus ? 'sel' : 'btn')
    const live = row.state !== 'closed' && row.state !== 'quiet'
    put(r.x0 + 2, y, row.state === 'working' ? spinner(v.t + s.y * 130) : m.glyph, fg(TONE[m.tone]))
    put(cx.place, y, clip(row.place, 18), fg(row.state === 'asking' || row.state === 'working' ? 'hi' : live ? 'ink' : 'mid'))
    if (from) put(cx.from, y, clip(row.connector, 8), fg('dim'))
    put(cx.state, y, row.state === 'closed' ? 'ended' : row.label, fg(TONE[m.tone]))
    const line = row.state === 'watching' ? `next check ${whenLabel(row.next, v.now)}` : v.nowLine(row.key) ?? ''
    put(cx.now, y, clip(clean(line), nowW), fg(live ? 'mid' : 'dim'))
    const age = ago(row.ageMs)
    put(x1 - 1 - age.length, y, age, fg('dim'))
  }
  return shown.map(s => ({ key: s.key, y: y0 + s.y }))
}

function steps(v: View, r: Rect) {
  if (v.mode === 'schedules') return scheduleRows(v, r, v.schedules.filter(s => s.key === v.open))
  if (!v.feed.length) { put(r.x0 + 2, r.y0 + 2, 'nothing in its transcript yet', 'mid'); return }
  const room = Math.max(1, r.y1 - r.y0 - 3), width = Math.max(10, r.x1 - r.x0 - 22)
  const lines: { at?: number; tag: string; text: string; tone: string }[] = []
  v.feed.slice(-room).forEach((s, i, all) => {
    const m = /^(\S+)\s+(.*)$/.exec(s.text)
    const tag = m ? m[1]! : '', newest = i === all.length - 1
    const tone = tag === 'reply' ? 'work' : tag === 'says' ? 'ink' : 'mid'
    let text = clean(m ? m[2]! : s.text)
    if (newest) text = text.slice(0, v.typed)
    const parts = text.match(new RegExp(`.{1,${width}}(\\s|$)|\\S+`, 'g')) ?? ['']
    parts.forEach((p, j) => lines.push({ ...(j === 0 && { at: s.at }), tag: j === 0 ? tag : '', text: p.trimEnd(), tone }))
  })
  lines.slice(-room).forEach((l, i) => {
    const y = r.y0 + 2 + i
    if (l.at !== undefined) put(r.x0 + 2, y, new Date(l.at).toTimeString().slice(0, 8), 'dim')
    put(r.x0 + 12, y, clip(l.tag, 7), l.tag === 'reply' ? 'work' : l.tag === 'task' || l.tag === 'input' ? 'you' : 'mid')
    put(r.x0 + 20, y, clip(l.text, width), l.tone)
  })
  const last = v.feed.at(-1)
  if (last && v.typed < last.text.length) { const end = lines.at(-1)!; put(r.x0 + 20 + [...end.text].length, r.y0 + 1 + Math.min(lines.length, room), '▌', 'work') }
  put(r.x0 + 2, r.y1 - 1, `$${v.threadSpend.toFixed(2)} today in this thread`, 'dim')
}

function scheduleRows(v: View, r: Rect, list: Schedule[]) {
  if (!list.length) { put(r.x0 + 2, r.y0 + 2, 'no schedules', 'mid'); return }
  put(r.x0 + 2, r.y0 + 1, 'NEXT', 'dim'); put(r.x0 + 14, r.y0 + 1, 'CRON', 'dim'); put(r.x0 + 30, r.y0 + 1, 'THREAD', 'dim'); put(r.x0 + 48, r.y0 + 1, 'TASK', 'dim')
  list.map(s => ({ s, at: v.nextOf(s) ?? Infinity })).sort((a, b) => a.at - b.at).slice(0, r.y1 - r.y0 - 3).forEach(({ s, at }, i) => {
    const y = r.y0 + 2 + i
    put(r.x0 + 2, y, at === Infinity ? '-' : whenLabel(at, v.now), 'ink')
    put(r.x0 + 14, y, clip(s.cron, 15), 'mid')
    put(r.x0 + 30, y, clip(v.placeOf(s.key), 17), 'ink')
    put(r.x0 + 48, y, clip(s.prompt.split('\n')[0]!, r.x1 - r.x0 - 50), 'mid')
  })
}

function kageletTable(v: View, r: Rect, focus: boolean) {
  const inner = r.x1 - r.x0
  const cols = ([[4, 'NAME'], [21, 'STATE'], [31, 'SCHEDULE'], [47, 'NEXT'], [59, 'TODAY'], [67, 'AVG'], [75, 'LAST REPORT']] as [number, string][]).filter(([x]) => x + 6 < inner)
  for (const [x, h] of cols) put(r.x0 + x, r.y0 + 1, h, 'dim')
  if (!v.kagelets.length) put(r.x0 + 4, r.y0 + 2, 'no kagelets yet', 'mid')
  const room = Math.max(1, Math.floor((r.y1 - r.y0) / 2) - 2)
  listRows(v.kagelets.map(k => k.name), v.kagelets[v.pick]?.name ?? '', room).forEach(({ key, y: i }) => {
    const k = v.kagelets.find(x => x.name === key)!
    const y = r.y0 + 2 + i, on = key === v.kagelets[v.pick]?.name
    const st = shownState(k, v.cap)
    const tone = st === 'broken' || st === 'over cap' ? 'you' : st === 'paused' ? 'dim' : 'work'
    const fg = (c: string) => (on ? (focus ? 'bg' : 'hi') : c)
    if (on) paint({ x0: r.x0 + 1, y0: y, x1: r.x1 - 1, y1: y }, focus ? 'sel' : 'btn')
    put(r.x0 + 2, y, st === 'paused' ? '◌' : st === 'on' ? '●' : '◆', fg(tone))
    const cells = [k.name, st, k.cron || `after ${k.after ?? ''}`, whenLabel(k.next, v.now), `$${k.costToday.toFixed(2)}`, `$${k.avg7.toFixed(2)}`, k.state === 'broken' ? k.error ?? '' : k.result?.summary ?? 'no report yet']
    cols.forEach(([x], j) => put(r.x0 + x, y, clip(cells[j]!, (cols[j + 1]?.[0] ?? inner) - x - 1), fg(j === 0 ? 'hi' : 'mid')))
  })
  const picked = v.kagelets[v.pick]
  if (!picked) return
  const y0 = r.y0 + 3 + Math.min(v.kagelets.length, room)
  put(r.x0 + 4, y0, picked.name, 'hi')
  put(r.x0 + 4, y0 + 1, clip(`made by ${picked.by === 'kage' ? 'Kage' : 'you'} · tools: ${picked.tools.join(', ') || 'read only'}${picked.model ? ` · model: ${picked.model}` : ''}`, r.x1 - r.x0 - 6), 'mid')
  v.runs.slice(0, r.y1 - y0 - 4).forEach((run, i) => put(r.x0 + 4, y0 + 3 + i, clip(runLine(run, v.now), r.x1 - r.x0 - 6), run.status === 'failed' ? 'bad' : 'mid'))
}

function charts(v: View, s: Screen) {
  const [a, b, c] = s.charts!
  const rows = a!.y1 - a!.y0 - 2
  const hourTurns = v.turns.filter(t => v.now - t >= 0 && v.now - t < 3_600_000).length
  const yA = (n: number) => String(n)
  const act = activityBins(v.turns, v.now, a!.x1 - a!.x0 - 4 - yA(0).length)
  const topA = Math.max(0, ...act.bins), axisA = Math.max(yA(topA).length, 1)
  pane(a!, false, [`turns every ${act.minutes === 1 ? 'minute' : `${act.minutes} min`}`], 0, `${hourTurns} in the last hour`)
  const startA = a!.x0 + 3 + axisA, endA = a!.x1 - 1, avail = endA - startA
  if (!hourTurns) put(startA + Math.max(0, Math.floor((avail - 24) / 2)), a!.y0 + Math.floor(rows / 2), 'no turns in the last hour', 'dim')
  else {
    put(a!.x0 + 1 + axisA - yA(topA).length, a!.y0 + 1, yA(topA), 'dim'); put(a!.x0 + axisA, a!.y0 + rows, '0', 'dim')
    const lines = bars(act.bins, rows)
    lines.forEach((line, i) => { for (let x = 0; x < avail; x++) put(startA + x, a!.y0 + 1 + i, line[Math.floor((x * act.bins.length) / avail)]!, 'work') })
  }
  put(startA - 1, a!.y1, ' -60m ', 'dim'); put(startA + Math.floor(avail / 2) - 3, a!.y1, ' -30m ', 'dim'); put(endA - 5, a!.y1, ' now ', 'dim')
  const hours = perHour(v.costs, v.now)
  const width = Math.floor((b!.x1 - b!.x0 - 8) / 2), shown = hours.slice(-width), first = hours.length - shown.length
  const topB = Math.max(0, ...shown), labelB = `$${topB.toFixed(2)}`
  pane(b!, false, ['spend per hour'], 0, `$${v.spentToday.toFixed(2)} today`)
  put(b!.x0 + 1, b!.y0 + 1, labelB, 'dim'); put(b!.x0 + 1 + labelB.length - 2, b!.y0 + rows, '$0', 'dim')
  const xB = b!.x0 + 2 + labelB.length
  bars(shown, rows).forEach((line, i) => [...line].forEach((ch, j) => put(xB + j * 2, b!.y0 + 1 + i, ch, j === line.length - 1 ? 'work' : 'mid')))
  for (const j of [0, Math.floor((shown.length - 1) / 2), shown.length - 1]) if (shown.length) put(xB + j * 2 - 1, b!.y1, ` ${String(first + j).padStart(2, '0')}h `, 'dim')
  pane(c!, false, ['kagelets'], 0, `${v.kagelets.filter(k => k.state === 'runs').length} of ${v.kagelets.length} on`)
  if (!v.kagelets.length) put(c!.x0 + 2, c!.y0 + 2, 'no kagelets yet', 'dim')
  v.kagelets.slice(0, c!.y1 - c!.y0 - 2).forEach((k, i) => {
    const y = c!.y0 + 1 + i
    put(c!.x0 + 2, y, k.state === 'paused' ? '◌' : '·', k.state === 'paused' ? 'dim' : 'mid')
    put(c!.x0 + 4, y, clip(k.name, 14), k.state === 'paused' ? 'dim' : 'ink')
    put(c!.x0 + 19, y, clip(k.state === 'paused' ? 'paused' : `next ${whenLabel(k.next, v.now)}`, c!.x1 - c!.x0 - 21), 'mid')
  })
}

function dialog(v: View) {
  const c = v.confirm!, w = Math.min(64, W - 4), h = c.body.length + 6
  const r = { x0: Math.floor((W - w) / 2), y0: Math.floor((H - h) / 2), x1: Math.floor((W - w) / 2) + w, y1: Math.floor((H - h) / 2) + h }
  fill(r, 'modal')
  put(r.x0, r.y0, `╭${'─'.repeat(w - 1)}╮`, 'you', 'modal'); put(r.x0, r.y1, `╰${'─'.repeat(w - 1)}╯`, 'you', 'modal')
  for (let y = r.y0 + 1; y < r.y1; y++) { put(r.x0, y, '│', 'you', 'modal'); put(r.x1, y, '│', 'you', 'modal') }
  put(r.x0 + 2, r.y0, ` ${c.title} `, 'you', 'modal')
  c.body.forEach((l, i) => put(r.x0 + 3, r.y0 + 2 + i, clip(l, w - 5), i ? 'mid' : 'ink', 'modal'))
  const no = '  n  keep it  ', yes = `  y  ${c.yes}  `
  put(r.x0 + Math.floor(w / 2) - no.length - 2, r.y1 - 2, no, 'ink', 'btn')
  put(r.x0 + Math.floor(w / 2) + 2, r.y1 - 2, yes, 'bg', 'ask')
}

function footer(v: View) {
  const y = H - 1
  fill({ x0: 0, y0: y, x1: W - 1, y1: y }, 'bar')
  if (v.message) { put(2, y, clip(v.message, W - 4), 'hi', 'bar'); return }
  if (v.paused) { put(2, y, clip(v.paused, W - 4), 'you', 'bar'); return }
  let x = 2
  for (const [a, b] of [['1-3', 'tabs'], ['tab', 'pane'], ['↑↓', 'pick'], ['/', 'search'], ['q', 'quit']]) {
    put(x, y, a!, 'work', 'bar'); put(x + a!.length + 1, y, b!, 'mid', 'bar'); x += a!.length + b!.length + 5
  }
  const tip = 'mouse: click a row or a tab'
  if (x + tip.length < W - 2) put(W - tip.length - 2, y, tip, 'dim', 'bar')
}

export function drawFrame(v: View): Hits {
  clear()
  const s = screen(W, H, !!v.ask)
  header(v)
  if (v.ask) banner(v, s.banner!)
  const wide = !!s.feed
  const showFeed = !wide && !!v.open && v.tab === 'threads'
  const listFocus = v.focus === 'list' || !wide
  const hints: Record<Tab, [string, string][]> = {
    threads: [['⏎', 'open'], ['a', 'attach'], ['x', 'cut']],
    kagelets: [['r', 'run'], ['p', 'pause'], ['u', 'resume'], ['v', 'revoke'], ['x', 'remove']],
    schedules: [],
  }
  let rows: { key: string; y: number }[] = []
  let tabs: Hits['tabs'] = []
  const full = { ...s.list, x1: s.feed && v.tab !== 'threads' ? s.feed.x1 : s.list.x1 }
  if (showFeed) {
    pane(s.list, true, ['steps', 'schedules'], v.mode === 'steps' ? 0 : 1, v.placeOf(v.open!), [['s', v.mode === 'steps' ? 'schedules' : 'steps'], ['esc', 'back']])
    steps(v, s.list)
  } else {
    const count = v.tab === 'threads' ? `${v.rows.length} · ${v.rows.filter(r => r.state !== 'closed' && r.state !== 'quiet').length} live` : v.tab === 'kagelets' ? `${v.kagelets.length}` : `${v.schedules.length}`
    tabs = pane(full, listFocus, TABS, TABS.indexOf(v.tab), count, hints[v.tab], true).map(t => ({ tab: TABS[t.tab]!, x0: t.x0, x1: t.x1, y: full.y0 }))
    if (v.tab === 'threads') rows = threadTable(v, full, listFocus)
    else if (v.tab === 'kagelets') kageletTable(v, full, listFocus)
    else scheduleRows(v, full, v.schedules)
  }
  if (s.feed && v.tab === 'threads') {
    const key = v.open ?? v.selKey
    pane(s.feed, v.focus === 'feed', ['steps', 'schedules'], v.mode === 'steps' ? 0 : 1, key ? v.placeOf(key) : '', [['s', v.mode === 'steps' ? 'schedules' : 'steps'], ['a', 'attach']])
    if (key) steps(v, s.feed)
  }
  if (s.charts && v.since > 0) charts(v, s)
  footer(v)
  if (v.confirm) dialog(v)
  return { rows, list: full, tabs }
}
