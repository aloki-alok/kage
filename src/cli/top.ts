#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { topicReader } from './top-topics.ts'
import { askHub, asOwner, CWD, DIR, inTerminal, settings } from './home.ts'
import { DatabaseSync } from 'node:sqlite'
import { boardAnswer, boardRows, refusedLine, FOLDED, liveThreadLines, nextRuns, limitLine, pauseLine, type Live, type Row, type State } from '../core/board.ts'
import { costRows, openWaiting } from '../core/ledgers.ts'
import { channels, filterRows, nextFilter, rowAt, spentToday, WIDE, type Filter } from '../core/top-layout.ts'
import { BG, resize, toText, W } from './top-screen.ts'
import { drawFrame, TABS, type Hits, type Tab, type View } from './top-draw.ts'
import { schedulesIn } from '../runtime/store.ts'
import { actionLine, dailyCap, kageletRuns, PANEL_KEYS, type PanelAction } from '../core/kagelets/view.ts'
import { kageletRows, type KageletRow } from '../core/kagelets/kagelet.ts'
import { kageletTier } from '../core/access.ts'
import { kageletsDir, readKagelets } from '../runtime/kagelets/files.ts'
import { ledgerText } from '../runtime/ledger.ts'
import { leftoverCount } from './top-leftovers.ts'
import { transcriptFeeds } from './top-feeds.ts'
import { hubAsker } from './top-hub.ts'

const HOME = process.env.HOME!
const PROJECT = `${HOME}/.claude/projects/${CWD.replace(/[^A-Za-z0-9]/g, '-')}`, topicFor = topicReader(PROJECT)
const DB = `${DIR}/kage.db`, SOCK = `${DIR}/router.sock`
const ONCE = process.argv.includes('--once')
if (!existsSync(DB)) { console.error(`No ${DB} yet: start Kage first.`); process.exit(1) }
const db = new DatabaseSync(DB, { readOnly: true })
const threadsQuery = db.prepare(`select s.key, s.claude_id as id, coalesce(c.place, s.key) as place, coalesce(c.last_seen, 0) as lastSeen,
  coalesce(c.connector, 'slack') as connector from sessions s left join conversations c using (key)`)

type Thread = { key: string; id: string; place: string; lastSeen: number; connector: string }
let live: Live | undefined, liveAt = 0
let known: Thread[] = [], showEnded = false
let schedules: ReturnType<typeof schedulesIn> = []
let next = new Map<string, number>(), nextAt = 0
let board: Row[] = [], rows: Row[] = []
let costs: { at: number; usd: number; key: string }[] = [], waiting: { thread: string; what: string }[] = [], ledgersAt = 0
let hubLog = ''
let kagelets: KageletRow[] = [], kageletsAt = 0, runs: ReturnType<typeof kageletRuns> = []
let upSec: number | undefined, upAt = 0

const boot = Date.now()
let tab: Tab = 'threads', focus: 'list' | 'feed' = 'list'
let selKey = '', open: string | undefined, openAt = 0, mode: 'steps' | 'schedules' = 'steps'
let searching = false, query = '', filter: Filter = 'all'
let message = '', messageAt = 0, hubRefused = ''
let confirm: { kind: 'cut' | 'remove'; target: string } | undefined
let suspended = false, pick = 0
let hits: Hits | undefined
const CAP = dailyCap(settings().config.kagelets), COST_BAR = settings().config.top?.threadCostBar ?? 5
const conn = settings().config.connectors
const CONNECTORS_ON = [conn?.email?.on && 'email', conn?.whatsapp?.on && 'whatsapp', conn?.voice?.on && 'voice', conn?.github && 'github'].filter((x): x is string => !!x)
const KAGELETS = kageletsDir(DIR)

const read = (f: string) => { try { return readFileSync(`${DIR}/${f}`, 'utf8') } catch { return '' } }
const tail = (file: string, bytes: number) => { try { const b = readFileSync(file); return b.subarray(Math.max(0, b.length - bytes)).toString('utf8') } catch { return '' } }
const mtime = (id: string) => { try { return statSync(`${PROJECT}/${id}.jsonl`).mtimeMs } catch { return 0 } }
const idOf = (key: string) => known.find(k => k.key === key)?.id
const placeOf = (key: string) => known.find(k => k.key === key)?.place ?? kagelets.find(k => k.key === key)?.name ?? key

const { feeds, follow, watchNext } = transcriptFeeds(PROJECT, idOf)

function refresh(now: number) {
  try { known = threadsQuery.all() as Thread[] } catch {}
  if (now - nextAt > 10_000) { schedules = schedulesIn(DB); next = nextRuns(schedules, now); nextAt = now }
  if (now - liveAt > 4_000) live = undefined
  const nx = new Map(next)
  for (const l of live?.live ?? []) {
    if (l.state !== 'watching') continue
    const w = watchNext(l.key, now)
    if (w !== undefined && w < (nx.get(l.key) ?? Infinity)) nx.set(l.key, w)
  }
  board = boardRows(known.map(k => ({ ...k, topic: topicFor(k.id) })), live, new Map(known.map(k => [k.key, mtime(k.id)])), nx, now, showEnded || !!query || filter !== 'all').rows
  rows = filterRows(board, query, filter)
  if (!rows.some(r => r.key === selKey)) selKey = rows[0]?.key ?? ''
  if (now - ledgersAt > 3_000) {
    ledgersAt = now
    try { costs = costRows(ledgerText(db, 'costs')).map(c => ({ at: c.at, usd: c.usd, key: c.key })) } catch {}
    try { waiting = openWaiting(ledgerText(db, 'waiting')) } catch {}
    hubLog = tail(`${DIR}/hub.log`, 200_000)
  }
  if (now - kageletsAt > 3_000) readKageletRows(now)
  for (const r of board) if (r.state !== 'closed') follow(r.key)
  const shown = open ?? selKey
  if (shown) follow(shown)
  if (now - upAt > 10_000) {
    upAt = now
    const pid = read('status').split(/\s+/)[3]
    const started = pid ? Date.parse(spawnSync('ps', ['-o', 'lstart=', '-p', pid], { encoding: 'utf8' }).stdout?.trim() ?? '') : NaN
    upSec = Number.isFinite(started) ? Math.round((now - started) / 1000) : undefined
  }
}

function readRuns(now: number) {
  const picked = kagelets[pick]; runs = picked && tab === 'kagelets' ? kageletRuns(picked.name, picked.key ?? '', { runs: ledgerTextSafe('runs'), costs: ledgerTextSafe('costs'), reports: ledgerTextSafe('reports') }, now) : []
}

function readKageletRows(now: number) {
  kageletsAt = now
  try { kagelets = kageletRows(readKagelets(KAGELETS), { runs: ledgerText(db, 'runs'), costs: ledgerText(db, 'costs'), reports: ledgerText(db, 'reports'), now }) } catch { kagelets = [] }
  pick = Math.max(0, Math.min(pick, kagelets.length - 1))
  readRuns(now)
}

const ask = hubAsker(SOCK)
async function pollHub() {
  const r = boardAnswer(await ask(asOwner({ type: 'board' })))
  hubRefused = r && 'refused' in r ? refusedLine(r.refused, inTerminal) : ''
  if (r && 'live' in r) { live = r.live; liveAt = Date.now() }
}

function view(now: number, t: number): View {
  const asking = board.find(r => r.state === 'asking')
  const shown = open ?? selKey
  const f = shown ? feeds.get(shown) : undefined
  const midnight = new Date(now).setHours(0, 0, 0, 0)
  return {
    now, t, since: now - boot,
    version: read('version').split(' ')[0] || undefined, hubUp: !!live,
    channels: channels({ slack: read('status').startsWith('connected'), log: hubLog, on: CONNECTORS_ON }),
    ...(upSec !== undefined && { upSec: upSec + Math.round((now - upAt) / 1000) }),
    spentToday: Math.round(costs.filter(c => c.at >= midnight).reduce((a, c) => a + c.usd, 0) * 100) / 100,
    ...(live && { slots: { used: live.live.filter(l => l.state === 'busy' || l.state === 'asking' || l.state === 'starting').length, max: live.max } }),
    rows, nowLine: key => feeds.get(key)?.steps.at(-1)?.text.replace(/^reply\s+/, '').replace(/^(\S+)\s+/, '$1 '),
    ...(asking && { ask: { place: asking.place, what: waiting.find(w => w.thread === asking.key)?.what || 'waits on your answer in Slack' } }),
    tab, focus, selKey, ...(open && { open }), mode, leftovers: leftoverCount(),
    feed: f?.steps ?? [], typed: (f?.changed ?? 0) > openAt ? Math.max(0, Math.floor((now - f!.changed) / 22)) : Infinity,
    threadSpend: (shown && spentToday(costs, now).get(shown)) || 0,
    schedules, nextOf: s => nextRuns([s], now).get(s.key), placeOf,
    kagelets, pick, runs, ...(CAP !== undefined && { cap: CAP }),
    turns: costs.map(c => c.at), costs,
    query, searching, filter, costBar: COST_BAR,
    ...(confirm && { confirm: confirm.kind === 'cut'
      ? { title: 'cut this session?', body: [`${placeOf(confirm.target)} is ${board.find(r => r.key === confirm!.target)?.label ?? 'open'}.`, 'Cutting stops its turn now. The next tag starts it again,', 'and it picks up the same conversation.'], yes: 'cut now' }
      : { title: `remove ${confirm.target}?`, body: [`Its file and its schedule go.`, 'This cannot be undone from here.'], yes: 'remove' } }),
    ...(message && now - messageAt < 5000 ? { message } : hubRefused && { message: hubRefused }),
    ...(live?.paused && { paused: pauseLine(live.paused) }),
  }
}
const ledgerTextSafe = (name: Parameters<typeof ledgerText>[1]) => { try { return ledgerText(db, name) } catch { return '' } }

const size = () => ({ cols: Number(process.env.COLUMNS) || process.stdout.columns || 80, rows: Number(process.env.LINES) || process.stdout.rows || 24 })
let lastRefresh = 0
function draw() {
  if (suspended) return
  resize(size())
  const now = Date.now()
  if (now - lastRefresh > 1000) { lastRefresh = now; refresh(now) }
  hits = drawFrame(view(now, now - boot))
  process.stdout.write(toText().map((l, i) => `\x1b[${i + 1};1H${l}`).join(''))
}

if (ONCE) {
  await pollHub()
  resize(size())
  refresh(Date.now())
  if (process.stdout.isTTY) { drawFrame(view(Date.now(), 1e9)); console.log(toText().join('\n')) }
  else for (const l of liveThreadLines(board, key => { follow(key); return feeds.get(key)?.steps.at(-1)?.text })) console.log(l)
  if (hubRefused) console.log(hubRefused)
  if (live?.paused) console.log(pauseLine(live.paused))
  const cost = limitLine(live?.limitCounts)
  if (cost) console.log(cost)
  process.exit(0)
}

if (!process.stdin.isTTY || !process.stdout.isTTY) { console.error('kage top needs a terminal. Use --once to print one frame.'); process.exit(1) }

const ENTER = '\x1b[?1049h\x1b[?25l\x1b[?1000h\x1b[?1006h', LEAVE = '\x1b[?1006l\x1b[?1000l\x1b[?25h\x1b[?1049l\x1b[0m'
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
const ATTACH_WHY: Partial<Record<State, string>> = { held: 'it is already open in a terminal' }

async function cut(key: string) {
  const r = await ask(asOwner({ type: 'stop', key }))
  if (r?.type !== 'stop') say(`Cannot cut ${placeOf(key)}: the hub does not answer.`)
  else if (r.ok) say(`Cut ${placeOf(key)}. It spins up again on its next task.`)
  else say(`Cannot cut ${placeOf(key)}: ${r.refused === 'busy' && live?.live.find(l => l.key === key)?.state === 'watching' ? 'a timed check is running in it' : CUT_WHY[r.refused as keyof typeof CUT_WHY] ?? r.refused}.`)
  await pollHub()
  refresh(Date.now())
}

function attach(key: string) {
  const r = board.find(x => x.key === key)
  if (!r) return
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
  let up = true
  const r = await askHub<{ type?: string; text?: string; refused?: string }>({ type: 'kagelet', action, name }).catch((e: Error) => { up = e.message !== 'down'; return undefined })
  say(actionLine(r, up && !!live))
  readKageletRows(Date.now())
}

function openThread(key: string) { if (key === FOLDED) return; open = key; selKey = key; openAt = Date.now(); mode = 'steps'; follow(key) }
const wide = () => W >= WIDE
const move = (d: number) => {
  if (tab === 'kagelets') { pick = Math.max(0, Math.min(kagelets.length - 1, pick + d)); readRuns(Date.now()); return }
  if (tab !== 'threads') return
  const keys = rows.map(r => r.key), at = Math.max(0, keys.indexOf(selKey))
  selKey = keys[Math.max(0, Math.min(keys.length - 1, at + d))] ?? selKey
  if (wide()) open = undefined
  else if (open) openThread(selKey)
  openAt = Date.now()
}

const TOKEN = /\x1b\[<(\d+);(\d+);(\d+)([Mm])|\x1b\[[A-D]|\x1b|[\s\S]/gu
async function onKey(k: string) {
  if (confirm) {
    const c = confirm
    confirm = undefined
    if (k === 'y') { if (c.kind === 'cut') await cut(c.target); else await act('remove', c.target) }
    return
  }
  if (searching) {
    if (k === '\x1b') { query = ''; searching = false } else if (k === '\r') searching = false
    else if (k === '\x7f') query = query.slice(0, -1)
    else if (k >= ' ' && k.length === 1) query += k
    refresh(Date.now())
    return
  }
  if (k === 'q' || k === '\x03') quit()
  else if (k === '1' || k === '2' || k === '3') { tab = TABS[Number(k) - 1]!; open = undefined; focus = 'list'; readRuns(Date.now()) }
  else if (k === '\t') focus = focus === 'list' && wide() && tab === 'threads' ? 'feed' : 'list'
  else if (k === '\x1b') { if (open) open = undefined; else if (query) { query = ''; refresh(Date.now()) } }
  else if (k === '\x1b[A' || k === 'k') move(-1)
  else if (k === '\x1b[B' || k === 'j') move(1)
  else if (k === '/') { tab = 'threads'; searching = true; open = undefined }
  else if (tab === 'kagelets') {
    const picked = kagelets[pick], action = PANEL_KEYS[k]
    if (k === '\r' && picked?.key) { tab = 'threads'; openThread(picked.key) }
    else if (action && picked) {
      if (action === 'remove') confirm = { kind: 'remove', target: picked.name }
      else if (action === 'revoke') { const tools = picked.tools.filter(t => kageletTier(t) === 'write'); if (!tools.length) say(`${picked.name} holds no write tool, so no standing approval.`); for (const t of tools) await act('revoke', t) }
      else await act(action, picked.name)
    }
  } else if (tab !== 'threads') return
  else if (k === 'f') { filter = nextFilter(filter); open = undefined; refresh(Date.now()) }
  else if (k === 's') { if (!open && selKey) openThread(selKey); mode = mode === 'steps' ? 'schedules' : 'steps' }
  else if (k === '\r') { if (selKey === FOLDED) { showEnded = !showEnded; refresh(Date.now()) } else if (selKey) openThread(selKey) }
  else if (k === 'x' && (open ?? selKey) && (open ?? selKey) !== FOLDED) confirm = { kind: 'cut', target: open ?? selKey }
  else if (k === 'a' && (open ?? selKey) && (open ?? selKey) !== FOLDED) attach(open ?? selKey)
}

function onMouse(b: number, x: number, y: number, press: boolean) {
  if (!hits || !press || confirm) return
  const cx = x - 1, cy = y - 1
  if (b === 64) return move(-1)
  if (b === 65) return move(1)
  if (b !== 0) return
  const t = hits.tabs.find(t => cy === t.y && cx >= t.x0 && cx <= t.x1)
  if (t) { tab = t.tab; open = undefined; readRuns(Date.now()); return }
  const key = rowAt(hits.rows.map(r => ({ key: r.key, y: r.y })), cy)
  if (key && cx >= hits.list.x0 && cx <= hits.list.x1) { if (key === selKey && !wide()) openThread(key); else { selKey = key; if (wide()) open = undefined } focus = 'list' }
}

process.stdin.on('data', async b => {
  if (suspended) return
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
setInterval(draw, 100)
