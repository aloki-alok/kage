#!/usr/bin/env node
// Kage hub: wires the pieces together. Rules belong in core/; the few still here are named below.
//   connectors/  Slack, email, WhatsApp, voice: hear a message, pass the gate, hand the hub a Task
//   core/        pure rules: the gate, the dispatcher, what may go out, ledgers, hook guards
//   runtime/     where sessions run (Agent SDK by default, or tmux panes), the socket, the store
// Still here: thread trust (noteTrust), how each connector shows a failure (failed), the daily
// "still waiting" note, the self-restart into a newer build, and the auto-update that pulls one.
// server.ts is the other end for tmux panes only: the Kage channel inside each pane's Claude Code.
import { execFileSync, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import { load, log } from './config.ts'
import { connectEmail } from './connectors/email.ts'
import { listenForCommands } from './connectors/slack-commands.ts'
import { connectSlack } from './connectors/slack.ts'
import { jevCheck } from './connectors/jev.ts'
import { jevConfig } from './core/jev.ts'
import { connectGithub } from './connectors/github.ts'
import { connectMeeting } from './connectors/meeting.ts'
import { connectBrowser } from './connectors/browser.ts'
import { blockList, unreadableBlocks } from './core/browser.ts'
import { connectVoice } from './connectors/voice.ts'
import { startWhatsApp } from './connectors/whatsapp.ts'
import { parseCommands } from './core/commands.ts'
import { memoryDirs } from './core/guards.ts'
import { limitLine, pauseLine, stopLine } from './core/board.ts'
import { placeFor, sessionKey, type Conversation, type Lane } from './core/conversations.ts'
import { mayStop, senderOf } from './core/gate.ts'
import { dailyDue, grantsLine, openWaiting, staleWaiting } from './core/ledgers.ts'
import { dreamDue, dreamTask, threadsSince } from './core/dream.ts'
import { retro, retroDue } from './core/retro.ts'
import { Dispatcher, mixRunners } from './core/sessions.ts'
import { reloader } from './core/settings.ts'
import type { Task, ToSession } from './runtime/protocol.ts'
import { postAsKage, sessionTools } from './runtime/kage-tools.ts'
import { scheduler } from './runtime/scheduler.ts'
import { runJobs } from './runtime/jobs.ts'
import { snapshotMemory } from './runtime/memory-snapshot.ts'
import { sdkSessions } from './runtime/sdk-sessions.ts'
import { limitPause } from './runtime/limit-pause.ts'
import { listenForSessions, restoreHolds, routeReply } from './runtime/session-link.ts'
import { openStore, type Inbox } from './runtime/store.ts'
import { costRecorder, openLedgers, runEvents } from './runtime/ledger.ts'
import { EVENT_DAYS } from './core/events.ts'
import { claudeProject, tmuxPanes } from './runtime/tmux-panes.ts'
import { codeStamp } from './runtime/code-stamp.ts'
import { clearUpdatedFrom, markUpdatedFrom, pullMain, updatedNote, version } from './runtime/auto-update.ts'
import { costCap, kageletDeliver, kageletManager, kageletRoutes, kageletsDir, ownerNotes, readCommand, readKagelets, syncKagelets } from './runtime/kagelets.ts'
import { budgetLeft, COST_FLAG, costFlags, kageletRows } from './core/kagelets.ts'
import { capError, chainCap, dailyCap, totalCap } from './core/kagelet-view.ts'
import { askHub } from './cli/home.ts'
import { hubLock } from './runtime/hub-lock.ts'
import { npmCi, packagesStale, rotate } from './runtime/hub-log.ts'
import { closedThreads } from './runtime/closed-threads.ts'

const { ENV_FILE, NAME, Title, TEAMMATES, TRUSTED_APPS, env, need, bot, user } = load()
const DIR = dirname(ENV_FILE)
// One hub per machine, checked before the store and Slack: two hubs on one Slack app split its events. A hub
// that answers on the socket in 2 s is running, so this one exits 0 and its supervisor leaves it down. A bare
// connect is not enough, because a hung hub still takes connects.
if (await askHub({ type: 'board' }, 2000).then(() => true, () => false)) {
  log('another hub is running and answers on its socket, so this one exits')
  process.exit(0)
}
// Two hubs started at the same moment both find no answer, so the lock decides (runtime/hub-lock.ts).
if (!await hubLock(`${DIR}/hub.lock`)) {
  log('another hub holds the hub lock, so this one exits')
  process.exit(0)
}
const THREADS = `${DIR}/threads.json`
// hub.ts sets the command that starts Claude Code with the kage channel.
const CLAUDE = process.env.KAGE_CLAUDE || (log('KAGE_CLAUDE is not set: start Kage with kage start'), process.exit(1))
// A Mac stays awake while the hub runs. caffeinate -i stops idle sleep only: with the lid closed, Kage is offline.
if (process.platform === 'darwin') spawn('caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore' }).on('error', () => {}).unref()
const MAX = Number(env.KAGE_MAX_SESSIONS || 4)
const IDLE_MIN = Number(env.KAGE_IDLE_MINUTES || 30)
process.on('unhandledRejection', e => log('unhandled', e))
// Every way the hub ends says why in the log: a signal (kage restart or stop), or a crash. An unhandled
// promise only logs: the hub keeps running.
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.on(sig, () => { log(`stopped by ${sig}`); process.exit(0) })
process.on('uncaughtException', e => { log('crashed', e); process.exit(1) })
let COMMANDS: Map<string, string>
try { COMMANDS = parseCommands(env.KAGE_COMMANDS || '') } catch (e) { log(String(e)); process.exit(1) }

// One SQLite file holds every conversation seen and the session working on each (runtime/store.ts).
const store = openStore(`${DIR}/kage.db`)
// What connectors keep across a restart, in the same file. The old JSON files move in once.
store.importState({ afk: `${DIR}/afk.json`, 'github-threads': `${DIR}/github-threads.json`, 'mail-threads': `${DIR}/mail-threads.json` })
// What Kage posted, waits on, spent and ran, in the same file (runtime/ledger.ts). Old .tsv files move in once.
const ledgers = openLedgers(DIR)
// The event log (core/events.ts): each run of a session or kagelet, and what it did, on one trace.
const runs = runEvents(ledgers, randomUUID)
const placeOf = (key: string) => placeFor(k => store.conversation(k)?.place, key)
// Every connector writes what it hears here before acknowledging it (runtime/store.ts, the inbox).
// A message a session took stays until its turn ends: a turn that hits the usage limit replays it (runtime/limit-pause.ts).
const inbox: Inbox = { take: (source, connector, payload) => store.take(source, connector, payload, Date.now()), handled: source => limits.handled(source), has: source => store.has(source) }

// Connectors hand the hub a conversation; the hub alone turns it into a session key.
// Who started each thread, for "@kage stop": a teammate may stop only a thread their own task started.
// ponytail: in memory, so after a hub restart only the owner can stop a thread; move to the store if teammates need more.
const starters = new Map<string, string>()
const deliver = (c: Conversation, task: Task, place: string, lane: Lane = 'main', by?: string) => {
  const key = sessionKey(c, { lane })
  if (by && !d.saved()[key] && !starters.has(key)) starters.set(key, by)
  store.seen(key, c, place, Date.now())
  return toSession(key, task)
}
// kage stop <thread> and "@kage stop": end a thread's session and its side lanes, after their turn or now.
// Messages no session read are let go.
function stopThread(key: string, cut: boolean): string {
  const now = Date.now()
  const end = (k: string) => {
    const r = d.endThread(k, now, cut)
    const dropped = 'ok' in r ? r.dropped.filter((m): m is Task => m.type === 'task') : []
    if (dropped.length) limits.turn(k, dropped, undefined, now)
    return { r, dropped: dropped.length }
  }
  const lanes = Object.keys(d.saved()).filter(k => k.startsWith(`${key}#`)).map(end).filter(l => 'ok' in l.r)
  const { r, dropped } = end(key)
  const let_go = dropped + lanes.reduce((n, l) => n + l.dropped, 0)
  const laneEnding = lanes.some(l => 'ok' in l.r && l.r.ending)
  // Only side lanes ran: the answer is theirs. A lane still in its turn makes it "after the current turn".
  const main = 'ok' in r ? { ...r, ...(laneEnding && { ending: true as const }), dropped: let_go }
    : lanes.length ? { ok: true as const, ...(laneEnding && { ending: true as const }), dropped: let_go } : r
  return stopLine(main, schedules.list(key).map(s => s.prompt.slice(0, 60)), lanes.length)
}
// Every task on its way to a session. Paused by the usage limit: it is held for the reset, and no session starts.
const toSession = (key: string, task: Task) => {
  if (closedTo(key, task)) return 'sent'
  if (limits.hold(key, task, Date.now())) return 'held'
  noteTrust(key, task)
  const r = d.task(key, task, Date.now())
  if (r !== 'failed') {
    limits.delivered(key, task)
    // Only SDK sessions report a turn's end, so a tmux pane gets no run events.
    if (sdk && !onPane.has(key)) runs.start(key, task.scheduled ? `scheduled ${task.job ?? ''}` : `task from the ${senderOf(task)}`, { fresh: !!task.scheduled, ...(task.handoff && { chain: task.handoff.chain, hops: task.handoff.hops }) })
  }
  return r
}
// A thread the safety check stopped starts over, closed to teammates until the owner writes (runtime/closed-threads.ts).
const { blocked, closedTo, isClosed } = closedThreads({
  store,
  reset: key => d.reset(key),
  say: (key, t, text) => void postAsKage({ title: Title, bot, user }, t.meta.channel, t.meta.thread_ts || undefined, text).then(
    r => ledgers.add('posted', [t.meta.channel, r.ts, r.by, key]),
    e => log('could not post the block line', key, e?.data?.error ?? e)),
  tellOwner: text => void slack.notifyOwner(text),
})
// A thread is owner-trusted while every task it got came from the owner by Slack (not email or voice); a schedule set up
// there runs with owner trust, anywhere else with a teammate's. Kept in the store so a restart keeps
// it. A thread with a session from before this was recorded starts untrusted: its history is unknown.
const noteTrust = (key: string, t: Task) =>
  store.noteTask(key, senderOf(t) === 'owner', key in d.saved())
// AFK's P0 call, the same route as `kage call` (cli/call.ts): a one-time code, then the dialer.
// The dialer may pass $KAGE_CALL_REASON to the voice agent. Resolves '' once placed, else why not.
function phoneOwner(reason: string): Promise<string> {
  const command = env.KAGE_CALL_COMMAND
  if (!command) return Promise.resolve('no KAGE_CALL_COMMAND')
  if (!voice) return Promise.resolve('voice is off (KAGE_VOICE_TOKEN)')
  const p = spawn(command, { shell: true, stdio: 'ignore', env: { ...process.env, KAGE_CALL_CODE: voice.issueCode(), KAGE_CALL_REASON: reason.slice(0, 300) } })
  const timer = setTimeout(() => p.kill(), 60_000)   // a dialer that hangs reports as failed
  return new Promise(res => { p.on('error', e => res(String(e))); p.on('close', code => { clearTimeout(timer); res(code === 0 ? '' : `dialer exited ${code ?? 'on timeout'}`) }) })
}
// The Jev classifier for agent posts (core/jev.ts). A wrong setting leaves it off and says why, so Kage still starts.
const jev = jevConfig(env)
if (jev && 'error' in jev) log(`jev is off: ${jev.error}`)
else if (jev) log(`jev checks ${jev.agents === 'all' ? 'every listed agent' : jev.agents.join(', ')} at threshold ${jev.threshold}`)

const slack = await connectSlack({
  dir: DIR, appToken: need('SLACK_APP_TOKEN'), bot, user, name: NAME, title: Title, teammates: TEAMMATES, apps: TRUSTED_APPS,
  hub: { deliver, stop: (c, cut, by) => {
      const key = sessionKey(c, { lane: 'main' })
      return mayStop(by, slack.ids.owner, starters, key) ? stopThread(key, cut) : 'Only the owner, or the teammate whose task started this thread, can stop it.'
    }, verdict: (id, behavior) => d.verdict(id, { type: 'verdict', request_id: id, behavior }), status, heard: m => schedules.heard(m),
    posted: () => ledgers.text('posted'), ownerWrote: (chat, thread, text) => { for (const k of notes.wrote(grants.keys(), chat, thread, text)) runs.emit(k, 'owner-note', `${text.length} characters`) }, ...inbox },
  // AFK mode is on unless KAGE_AFK=off. Its stand-in reads the owner's memory, read only.
  jev: jev && !('error' in jev) ? jevCheck(jev) : undefined,
  afk: env.KAGE_AFK === 'off' ? undefined : { memory: memoryDirs(process.env.HOME!, ENV_FILE, env).owner, model: env.KAGE_AFK_MODEL || 'sonnet', saved: store, call: phoneOwner },
})

// threads.json came before the store: move it in once (the "dm" key needs the bot DM's id), then retire it.
if (existsSync(THREADS)) {
  const r = store.importThreads(JSON.parse(readFileSync(THREADS, 'utf8')), slack.ids.botDm, Date.now())
  log(`moved threads.json into the store: ${r.imported} threads${r.skipped.length ? `, skipped ${r.skipped.join(' ')}` : ''}`)
  renameSync(THREADS, `${THREADS}.imported`)
}
// Name the imported threads once, in the background: a failed lookup keeps the key for the next start.
void (async () => {
  for (const t of store.unnamed()) {
    const place = await slack.placeOf(t.chat).catch(() => t.chat)
    if (place !== t.chat) store.name(t.key, place)
  }
})()

const tmux = tmuxPanes({
  name: NAME, envFile: ENV_FILE, claude: CLAUDE,
  idOf: key => d.saved()[key],
  placeOf,
  onStart: () => store.saveSessions(d.saved()),
})
// Each thread runs as an Agent SDK session inside this process, unless KAGE_RUNTIME=tmux gives it a
// tmux pane. A missing SDK package falls back to panes.
// Panes still running when the hub starts keep their thread (and their CronCreate jobs) until they
// close; see mixRunners.
const MEM = memoryDirs(process.env.HOME!, ENV_FILE, env)
const PROJECT = claudeProject(process.cwd())   // both runners start sessions in the hub's folder, so transcripts live here
// What each turn cost (runtime/ledger.ts costRecorder): `kage cost`, the kagelet caps and the cost flags read it.
const recordCost = costRecorder(ledgers)
// Kage in Chrome (#114): the owner's own browser, through Kage's extension, for the owner's own tasks only.
rmSync(`${DIR}/browser-seen`, { force: true })   // a poll the last hub heard says nothing about this one
let browserSeen = 0   // kage doctor reads browser-seen; written at most every 30 s, since the extension polls about every 25 s
const browser = env.KAGE_BROWSER_TOKEN ? connectBrowser({ token: env.KAGE_BROWSER_TOKEN, port: Number(env.KAGE_BROWSER_PORT || 8791),
  onPoll: at => { if (at - browserSeen >= 30_000) { browserSeen = at; writeFileSync(`${DIR}/browser-seen`, String(at), { mode: 0o600 }) } } }) : undefined
void browser?.listening.then(port => log(`browser on: 127.0.0.1:${port}/browser`), e => log('browser could not listen', e))
const BROWSER_BLOCK = blockList(env.KAGE_BROWSER_BLOCK ?? '')
for (const e of unreadableBlocks(env.KAGE_BROWSER_BLOCK ?? '')) log(`KAGE_BROWSER_BLOCK: "${e}" is not a site, so it blocks nothing`)
const sdkLib = env.KAGE_RUNTIME === 'tmux' ? undefined : await (async () => ({
  lib: await import('@anthropic-ai/claude-agent-sdk'),
  // The same pinned Claude Code the panes run, not the copy bundled with the SDK.
  claude: execFileSync('/bin/sh', ['-c', 'command -v claude'], { encoding: 'utf8' }).trim(),
}))().catch((e: Error) => {
  console.error(`Agent SDK not usable (${e.message}), so threads open as tmux panes. Run npm ci, then restart.`)
  return undefined
})
// Kagelets (#57): one file each in the kagelets folder, synced at start and each minute. Each runs on its
// schedule in a side lane of its thread, at teammate trust, with only its grant, and approves nothing.
let grants = new Map<string, string[]>()
const KAGELETS = kageletsDir(DIR, log)
// The names from before the rename still read.
const MAX_KAGELETS = Number(env.KAGE_MAX_KAGELETS || env.KAGE_MAX_SPECIALISTS || 10)
// Off unless set (#96); a value that does not read as dollars is said once, here.
const CAPS = { each: dailyCap(env), total: totalCap(env), chain: chainCap(env) }
if (capError(env)) log(capError(env)!)
// Only the SDK runner enforces a grant, so with tmux panes no kagelet runs: their schedules are removed.
// A kagelet over its daily cost cap is paused and flagged first, so this sync already drops its schedule.
const kagelets = (now: number) => {
  let files = readKagelets(KAGELETS)
  if (!sdk && files.length) { if (!kageletsRefused) log('kagelets need the Agent SDK runner (not KAGE_RUNTIME=tmux), so none runs'); kageletsRefused = true; files = [] }
  const ran = ledgers.text('runs'), costs = ledgers.text('costs')
  const rows = kageletRows(files, { runs: ran, costs, now })
  // Cost monitoring (#96): one line per kagelet a day in the reports ledger, where Kage reads it, and the event log. No DM.
  for (const f of costFlags(rows, { runs: ran, costs, reports: ledgers.text('reports') }, now)) { ledgers.add('reports', [`${COST_FLAG}${f.name}`, f.line, '']); log(`kagelet cost flag: ${f.line}`) }
  if (costCap({ dir: KAGELETS, store, title: Title, tell: text => void slack.notifyOwner(text), flag: (name, why) => {
    const r = rows.find(x => x.name === name)!
    ledgers.add('reports', [name, why, 'the owner to resume it, or a higher cap'])
    runs.emit(r.key!, 'cap-pause', why)
    ledgers.add('waiting', ['open', r.key!.split('#')[0]!, r.link ?? '', `kagelet ${name} ${why}`])
    log(`kagelet ${name} ${why}`)
  } }, rows, CAPS, now).length) files = readKagelets(KAGELETS)
  grants = syncKagelets(files, store, now, log, MAX_KAGELETS)
}
// The manager's side, for Kage's owner sessions (runtime/kage-tools.ts), and the owner's notes to a kagelet.
const manager = kageletManager({ dir: KAGELETS, max: MAX_KAGELETS, ledgers, sync: kagelets, runNow: (id, now) => schedules.runNow(id, now), store, envCommand: env.KAGE_DB_READ_COMMAND, log })
const notes = ownerNotes(store)
// Chains and kagelet messages (#93): the hub hands one kagelet's output or message to another, with no Kage turn.
const routes = kageletRoutes({ dir: KAGELETS, store, ledgers, runs, deliver: (key, task) => toSession(key, task),
  idle: key => !isClosed(key) && d.ready(key) === 'ready' && d.startsNow(key, Date.now()), paused: now => limits.paused(now)?.until, capUsd: CAPS.each, chainUsd: CAPS.chain, log })
let kageletsRefused = false
const sdk = sdkLib ? sdkSessions({
  sdk: sdkLib.lib,
  hub: () => d,
  tools: (key, send, approve) => sessionTools({
    title: Title, bot, user, botDm: () => slack.ids.botDm, dir: DIR, ledgers, send, memory: MEM,
    schedules: { add: j => schedules.add(key, j, Date.now()), remove: id => schedules.remove(key, id), list: () => schedules.list(key) },
    afk: slack.afk?.command,
    kagelet: key.split('#side-kagelet-')[1],
    browser: browser && { call: browser.call, block: BROWSER_BLOCK },
    dbRead: { command: () => readCommand(env.KAGE_DB_READ_COMMAND, store, key.split('#side-kagelet-')[1] ?? ''), maxRows: Number(env.KAGE_DB_READ_MAX_ROWS) || 200 },
    kagelets: { list: () => manager.list(Date.now()), manage: (a, ask) => manager.manage(a, Date.now(), ask) }, approve,
    event: (kind, detail) => runs.emit(key, kind, detail),
    onReport: r => routes.reported(key, r), message: (to, text) => routes.message(key, to, text),
  }),
  hasTranscript: tmux.hasTranscript,
  toHub: (key, m) => routeReply(key, m, replies),
  options: {
    cwd: process.cwd(),
    settingSources: ['user', 'project', 'local'],
    settings: { autoMemoryDirectory: MEM.own },
    pathToClaudeCodeExecutable: sdkLib.claude,
  },
  ownerMemory: MEM.owner,
  envFile: ENV_FILE,
  onStart: () => store.saveSessions(d.saved()),
  onResult: (key, total, resumed, limited) => {
    const usd = recordCost(key, total, resumed)
    routes.ended(key, usd ?? 0, d.saved()[key] ? `${PROJECT}/${d.saved()[key]}.jsonl` : '', Date.now(), limited)
  },
  budgetOf: key => key.includes('#side-kagelet-') ? budgetLeft(kageletRows(readKagelets(KAGELETS), { runs: '', costs: ledgers.text('costs'), now: Date.now() }), key, CAPS) : undefined,
  onBlocked: blocked,
  onTurn: (key, tasks, limit, done) => limits.turn(key, tasks, limit, Date.now(), done),
  // A lane whose file is gone keeps no tools, rather than falling back to approval cards.
  // A lane from before the rename (#side-spec-) gets no tools either.
  grantOf: key => grants.get(key) ?? (key.includes('#side-kagelet-') || key.includes('#side-spec-') ? [] : undefined),
  onTool: (key, tool, refused) => runs.emit(key, refused ? 'refusal' : 'tool', refused ? `${tool}: ${refused}` : tool),
}) : undefined
if (sdk) mkdirSync(MEM.own, { recursive: true })
kagelets(Date.now())

// A thread whose transcript is gone has nothing to resume, so it leaves the store. A pane that just
// started has no transcript yet, so running panes are kept.
const saved = store.sessions()
const runningAtStart = tmux.running()
for (const [k, id] of Object.entries(saved)) if (!tmux.hasTranscript(id) && !runningAtStart.has(id)) { delete saved[k]; store.forget(k) }

// The dev route waits for a person to confirm a warning screen in each new pane. A full house hands
// the slot of a session quiet for 2 min to a new thread.
const onPane = new Set(Object.keys(saved).filter(k => runningAtStart.has(saved[k]!)))
const runner = !sdk ? tmux.runner : onPane.size ? mixRunners(tmux.runner, sdk.runner, onPane) : sdk.runner
const d: Dispatcher<ToSession> = new Dispatcher<ToSession>(runner, {
  max: MAX, idleMs: IDLE_MIN * 60_000, connectMs: (CLAUDE.includes('development-channels') ? 30 : 3) * 60_000,
  evictMs: 2 * 60_000, newId: randomUUID, saved,
})
// The usage-limit pause: a turn that ends on the limit keeps its message and replays it at the reset (runtime/limit-pause.ts).
const limits = limitPause({
  store, log, settle: (tasks, done) => routes.settle(tasks, done),
  tellOwner: text => void slack.notifyOwner(text),
  end: key => d.end(key).filter(m => m.type === 'task'),
  // A tmux pane reports no turn end, so its messages are handled at delivery, as before.
  defers: key => !!sdk && !onPane.has(key),
  // The route a reply takes, so a group DM or a teammate's DM the bot cannot see still hears it.
  notice: (t, text) => void postAsKage({ title: Title, bot, user }, t.meta.channel, t.meta.thread_ts || undefined, text).then(
    r => ledgers.add('posted', [t.meta.channel, r.ts, r.by, `${t.meta.channel}:${t.meta.thread_ts}`]),
    e => log('could not post the pause notice', t.meta.place, e?.data?.error ?? e)),
  replay: r => replayOf(r.connector)?.(r.source, r.payload) ?? Promise.reject(new Error(`no ${r.connector} connector to replay through`)),
  redeliver: (key, task) => { if (toSession(key, task) === 'failed') failed(task) },
})
limits.restore()
// Panes still running from before this hub restarted keep working.
d.adopt(Object.keys(saved).filter(k => runningAtStart.has(saved[k]!)), Date.now())
// Threads still open in a terminal (kage attach) stay held: before any connector can deliver a task.
restoreHolds(DIR, d, Date.now())
// Schedules live in the store and run as tasks in their thread (runtime/scheduler.ts).
const schedules = scheduler({
  store, failed,
  deliver: kageletDeliver(notes, toSession),
  ready: key => d.ready(key),
  trusted: key => store.trust(key) === true,
  ran: j => ledgers.add('runs', [j.id, j.key]),
})
// CronCreate jobs moved out of stopped tmux panes (cli/export-crons.ts): adopted once, then retired.
// Only when no pane survived this start: a pane still running would run each job a second time.
const CRONS = `${DIR}/crons-import.json`
if (existsSync(CRONS) && runningAtStart.size) log('crons-import.json waits: panes are still running, so their jobs are still alive')
else if (existsSync(CRONS)) {
  try {
    const f = JSON.parse(readFileSync(CRONS, 'utf8'))
    const r = schedules.adopt(f.jobs, f.ranUntil)
    log(`adopted ${r.adopted.length} cron jobs from the panes${r.skipped.length ? `, skipped ${r.skipped.join(' ')}` : ''}`)
    renameSync(CRONS, `${CRONS}.imported`)
  } catch (e) {
    // A broken file must not keep Kage down: set it aside and say so.
    log('crons-import.json is unreadable, moved to .bad', e)
    renameSync(CRONS, `${CRONS}.bad`)
    void slack.notifyOwner('Could not read the cron jobs exported from the panes (crons-import.json.bad). Watchers may need setting up again.')
  }
}

const readFile = (f: string) => { try { return readFileSync(f, 'utf8') } catch { return '' } }
function status(): string {
  const s = d.status(Date.now())
  const min = (ms: number) => `${Math.round(ms / 60_000)} min`
  const lines = s.live.map(l => `• ${placeOf(l.key)}: ${l.state}${l.state === 'quiet' ? ` for ${min(l.quietMs)}` : ''}`)
  const open = openWaiting(ledgers.text('waiting')).length
  const paused = limits.paused()
  return [
    ...(paused ? [`*${pauseLine(paused)}*`] : []),
    ...[limitLine(limits.counts)].filter((l): l is string => !!l),
    `*${s.live.length} of ${MAX} sessions*${s.waiting.length ? `, ${s.waiting.length} waiting for a slot` : ''}`,
    ...lines,
    ...s.waiting.map(k => `• ${placeOf(k)}: waiting for a slot`),
    ...s.held.map(k => `• ${placeOf(k)}: open in your terminal (kage attach), tasks wait`),
    `${open} question${open === 1 ? '' : 's'} waiting on you`,
  ].join('\n')
}

// Once a day from 05:00 UTC, the owner gets the questions that have waited on them for a day or more.
const DAILY = `${DIR}/daily-sent`
async function dailyNote(now: number) {
  const today = dailyDue(now, readFile(DAILY).trim() || undefined)
  if (!today) return
  const stale = staleWaiting(ledgers.text('waiting'), now, 24 * 3600_000)
  // The day before this note's 05:00 UTC, so a retried note neither skips nor repeats a grant.
  const at = Date.parse(`${today}T05:00:00Z`)
  const noCard = grantsLine(ledgers.text('grants'), at - 24 * 3600_000, at)
  const parts = [...stale.length ? [[`*Still waiting on you (${stale.length})*`,
    ...stale.map(i => `• ${i.link ? `<${i.link}|${i.what}>` : i.what} (since ${i.when.slice(0, 10)})`)].join('\n')] : [], ...noCard ? [noCard] : []]
  const sent = !parts.length || await slack.notifyOwner(parts.join('\n\n'))
  // Marked only once the note went out (or there was nothing to say), so a failed post retries.
  if (sent) writeFileSync(DAILY, today, { mode: 0o600 })
}
// Monday morning, the owner gets the weekly retro: what Kage's own ledgers say to change (core/retro.ts).
const RETRO = `${DIR}/retro-sent`
async function weeklyRetro(now: number) {
  const last = Number(readFile(RETRO)) || undefined
  if (!retroDue(now, last)) return
  const lines = retro({ schedules: store.schedules(), placeOf, runs: ledgers.text('runs'), posted: ledgers.text('posted'), costs: ledgers.text('costs'), costTracked: !!sdk, now })
  const sent = !lines.length || await slack.notifyOwner(['*Weekly retro*, from what Kage did this week.', ...lines].join('\n'))
  if (sent) writeFileSync(RETRO, String(now), { mode: 0o600 })
}
// Every night in the small hours, while every session is quiet, Kage learns from the day's threads and
// tidies its own memory (core/dream.ts). A side lane of the bot DM, so the DM's own conversation is
// untouched. The hub snapshots the memory first, so `kage dream undo` restores it whatever the dream did.
const DREAMT = `${DIR}/dream-sent`
function dream(now: number) {
  const last = Number(readFile(DREAMT).trim()) || undefined
  if (limits.paused() || !dreamDue(now, last, d.quietEverywhere(now))) return   // a dream in the pause would only hit the limit
  const snap = snapshotMemory(MEM.own, now)
  // At most a day back, so a Mac that slept through a few nights is not handed a week of threads.
  const since = Math.max(last ?? 0, now - 24 * 3600_000)
  const file = (id: string) => `${PROJECT}/${id}.jsonl`
  const threads = threadsSince(store.sessions(), id => { try { return statSync(file(id)).mtimeMs } catch { return undefined } }, since)
    .map(t => ({ place: placeOf(t.key), file: file(t.id) }))
  const c: Conversation = { connector: 'slack', chat: slack.ids.botDm, kind: 'dm', agentDm: true }
  const task: Task = {
    type: 'task', fromOwner: true, content: dreamTask(MEM, threads, new Date(since).toISOString()),
    meta: { channel: slack.ids.botDm, thread_ts: '', place: `DM with ${Title} (dream)`, permalink: '' },
    origin: { channel: slack.ids.botDm, ts: '' },
    scheduled: true,
  }
  log('dream starts, memory saved to', snap)
  if (deliver(c, task, task.meta.place, 'side-dream') !== 'failed') writeFileSync(DREAMT, String(now), { mode: 0o600 })
}
// GitHub is on when KAGE_GITHUB_SECRET and KAGE_GITHUB_LOGIN are set: a webhook through a tunnel.
const github = env.KAGE_GITHUB_SECRET && env.KAGE_GITHUB_LOGIN ? connectGithub({
  saved: store, secret: env.KAGE_GITHUB_SECRET, login: env.KAGE_GITHUB_LOGIN, port: Number(env.KAGE_GITHUB_PORT || 8789), botDm: slack.ids.botDm,
  post: (text, thread) => bot.chat.postMessage({ channel: slack.ids.botDm, text, ...(thread && { thread_ts: thread }) }).then(r => r.ts, e => { log('github post failed', e); return undefined }),
  deliver: (c, task, place) => deliver(c, task, place),
  notify: text => void slack.notifyOwner(text),
  perHour: Number(env.KAGE_GITHUB_PER_HOUR || 20), inbox,
}) : undefined
void github?.listening.then(port => log(`github on: 127.0.0.1:${port}/github for @${env.KAGE_GITHUB_LOGIN}`))
// Meetings are on when KAGE_MEETING_TOKEN is set: a finished transcript gets notes in its own DM thread.
const meeting = env.KAGE_MEETING_TOKEN ? connectMeeting({
  token: env.KAGE_MEETING_TOKEN, port: Number(env.KAGE_MEETING_PORT || 8790), botDm: slack.ids.botDm,
  post: text => bot.chat.postMessage({ channel: slack.ids.botDm, text }).then(r => r.ts, e => { log('meeting post failed', e); return undefined }),
  deliver: (c, task, place) => deliver(c, task, place),
  notify: text => void slack.notifyOwner(text),
  perHour: Number(env.KAGE_MEETING_PER_HOUR || 10), inbox, untake: source => store.untake(source),
}) : undefined
void meeting?.listening.then(port => log(`meetings on: 127.0.0.1:${port}/meeting`))
const email = connectEmail({
  env, saved: store, name: NAME, deliver, inbox,
  failed: task => void slack.notifyOwner(`Could not start a session for ${task.meta.place}.`),
})
// Voice is on when KAGE_VOICE_TOKEN is set, unless KAGE_VOICE=off. A voice agent reaches it over a tunnel.
const voice = connectVoice({
  env, name: NAME, deliver,
  end: key => { if (key.startsWith('voice:')) d.end(key) },   // only the call's own session
  slot: key => d.hasFreeSlot(key),   // a call never evicts or queues ahead of the owner's threads
  failed: task => void slack.notifyOwner(`Could not start a session for ${task.meta.place}.`),
})
listenForCommands(slack.socket, { user, team: slack.ids.team!, commands: COMMANDS, ledgers })

// WhatsApp is on when Kage's WAHA config exists, unless KAGE_WHATSAPP=off (the kill switch).
const whatsapp = env.KAGE_WHATSAPP !== 'off' && existsSync(`${DIR}/waha/.env`) ? startWhatsApp({
  dir: DIR, name: NAME, owner: slack.ownerName, env, inbox,
  notify: text => void slack.notifyOwner(text),
  // The stand-in reads only this folder: notes the owner wrote for it, never their whole memory.
  memory: env.KAGE_WA_MEMORY || `${DIR}/wa-notes`,
  onTask(t) {
    const task: Task = {
      type: 'task', content: t.content, fromOwner: true,
      meta: { channel: 'whatsapp', thread_ts: t.chat, place: t.place, permalink: '' },
      origin: { channel: 'whatsapp', ts: t.chat },
    }
    log('whatsapp task for', t.place)
    if (deliver({ connector: 'whatsapp', chat: t.chat, kind: 'chat' }, task, t.place) === 'failed') failed(task)
  },
}) : undefined

// Each connector marks its own failures: ⚠️ on a Slack message, a DM line for an email or WhatsApp
// chat or a scheduled run (it has no message to mark).
function failed(m: ToSession) {
  if (m.type !== 'task') return
  limits.turn('', [m], undefined, Date.now())   // no turn will end for it: its inbox message is done
  log('could not deliver to a session:', m.meta.place, m.origin.ts, `(attach: tmux attach -t ${NAME})`)
  if (!m.origin.ts) void slack.notifyOwner(`Could not start a session for a scheduled run in ${m.meta.place}.`)
  else if (m.origin.channel === 'email' || m.origin.channel === 'whatsapp' || m.origin.channel === 'voice') void slack.notifyOwner(`Could not start a session for ${m.meta.place}.`)
  else slack.failed(m)
}

// Kage updates itself: newer code (a merge, a pull, the install line again) takes over once
// nothing would be cut off. It exits 75, and the supervisor (service.sh) starts it again.
// ponytail: a live cron job inside the hub (SDK) counts as busy, so it delays the update; restart by hand then. A pane outlives the hub.
// The change must be settled for 10s, so a merge still writing files is never picked up half-done.
// Compared to the boot stamp, not the clock, so a file with a future time cannot restart the hub over and over.
// Not in a usage-limit pause: the scheduled runs it owes live in memory (runtime/limit-pause.ts), and a hub
// that held only those would start unpaused and run into the limit again.
const CODE = dirname(fileURLToPath(import.meta.url))
const BOOT_CODE = codeStamp(CODE)
// The version of the code this hub runs, read once: kage status and kage doctor show it from this file.
const VERSION = version(CODE)
writeFileSync(`${DIR}/version`, `${VERSION}\n`, { mode: 0o600 })
let npmFailedFor = 0   // the code stamp whose npm ci failed: not tried again until the code moves
function selfUpdate(now: number) {
  const code = codeStamp(CODE)
  if (code && code !== BOOT_CODE && now - code > 10_000 && d.quietEverywhere(now) && !limits.paused(now)) {
    // New code may need new packages: npm stamps node_modules/.package-lock.json on each install.
    if (packagesStale(CODE)) {
      if (npmFailedFor === code) return
      try { npmCi(CODE) } catch {
        npmFailedFor = code
        log('npm ci failed for the newer code, so the hub stays on the code it runs. Run npm ci in', CODE)
        return
      }
    }
    log('newer code is in place and every session is quiet: restarting into it')
    process.exit(75)
  }
}

// Auto-update moves a clean main checkout to origin's stable tag (core/auto-update.ts); selfUpdate above then restarts into it.
// ponytail: no signature check yet (#58), so a bad move of the stable tag reaches this install within 6 hours.
async function autoUpdate() {
  const r = await pullMain(CODE)
  if (r === 'pulled') { markUpdatedFrom(DIR, VERSION); log('auto-update pulled the stable tag: the hub restarts into it once every session is quiet') }
  else if (r !== 'current') log(`auto-update did nothing: ${r.skip}`)
}

// Every timed job of the hub, on one clock (runtime/jobs.ts).
runJobs([
  // A drain for kage restart or stop starts no scheduled run: one due now runs after the restart.
  { name: 'schedules', every: 20_000, run: now => { if (!limits.draining(now)) schedules.tick(now) } },
  { name: 'sweep', every: 60_000, run: now => d.sweep(now).forEach(failed) },
  { name: 'limit pause', every: 20_000, run: now => limits.tick(now) },
  { name: 'daily note', every: 10 * 60_000, run: dailyNote },
  { name: 'self-update', every: 60_000, run: selfUpdate },
  ...env.KAGE_AUTO_UPDATE === 'off' ? [] : [{ name: 'auto-update', every: 6 * 3_600_000, run: autoUpdate }],
  // hub.ts rotates the log at each start; a hub that runs for weeks rotates it here.
  { name: 'hub-log', every: 3_600_000, run: () => rotate(`${DIR}/hub.log`) },
  { name: 'kagelets', every: 60_000, run: kagelets },
  { name: 'dream', every: 10 * 60_000, run: dream },
  { name: 'retro', every: 10 * 60_000, run: weeklyRetro },
  // A kagelet message waits until its target is idle, then starts a run of its own (runtime/kagelets.ts).
  { name: 'kagelet messages', every: 20_000, run: now => routes.pump(now) },
  { name: 'events', every: 3_600_000, run: now => ledgers.pruneEvents(new Date(now - EVENT_DAYS * 86_400_000).toISOString()) },
])

const replies = {
  voice: (key: string, text: string) => voice?.reply(key, text),
  wa: (key: string, text: string) => void whatsapp?.send(key, text).catch(e => log('whatsapp send failed', key, e)),
  mail: (key: string, text: string) => void email?.send(key, text).catch(e => {
    log('mail reply failed', key, e)
    void slack.notifyOwner(`Email reply failed for ${placeOf(key)}: ${e}`)
  }),
}
// How a stored message runs again: through its own connector, as if just heard.
function replayOf(connector: string): ((source: string, payload: string) => Promise<unknown>) | undefined {
  return ({ slack: slack.replay, github: github?.replay, meeting: meeting?.replay, whatsapp: whatsapp?.replay } as Record<string, ((source: string, payload: string) => Promise<unknown>) | undefined>)[connector]
}
// kage tell: the owner's words into a thread, typed on this machine. Same shape as a scheduled run (runtime/scheduler.ts).
function tell(key: string, text: string): { ok: true; held?: true } | { refused: string } {
  const c = store.conversation(key)
  if (!c) return { refused: 'no thread with that key' }
  // ponytail: Slack only, like schedules; email and WhatsApp tasks need their connector's own meta, add when wanted.
  if (c.conversation.connector !== 'slack') return { refused: 'tell works on Slack threads only for now' }
  // Typed words have no inbox message to replay, so they are refused instead of lost.
  const paused = limits.paused()
  if (paused) return { refused: `Kage is paused by the usage limit, so it would be lost. ${pauseLine(paused)} Tell it again after that` }
  const task: Task = {
    type: 'task', fromOwner: true, content: `From the owner, typed in the terminal: ${text}`,
    meta: { channel: c.conversation.chat, thread_ts: c.conversation.thread ?? '', place: c.place, permalink: '' },
    origin: { channel: c.conversation.chat, ts: '' },
  }
  log('tell', c.place)
  closedTo(key, task)   // the owner's words reopen a closed thread
  noteTrust(key, task)
  const r = d.task(key, task, Date.now())
  if (r === 'failed') { failed(task); return { refused: 'could not start a session there' } }
  return r === 'held' ? { ok: true, held: true } : { ok: true }
}
// kage reload: a changed allow list applies to the next message, with no restart and no turn cut (core/settings.ts).
const reload = reloader({ boot: env, read: () => readFileSync(ENV_FILE, 'utf8'), apply: slack.allow, log })
listenForSessions(`${DIR}/router.sock`, d, { ...replies, failed, schedules, tell, reload, paused: () => limits.paused(), limitCounts: () => limits.counts,
  // kage restart and stop: a drain renewed by each ask. A turn that just ended does not hold them up: its follow-up
  // waits too. Nor does a thread open in a terminal: kage attach holds it again after the restart.
  end: (key, cut) => stopThread(key, cut), kagelet: (action, name) => manager.manage({ action, name }, Date.now()),
  quiesce: () => { const now = Date.now(); limits.drain(now); return d.unquiet(now).filter(u => u.why !== 'just active' && u.why !== 'open in a terminal') }, callCode: voice?.issueCode })

await slack.start()
const updated = updatedNote(DIR, CODE, VERSION)
if (updated) { log(updated); void slack.notifyOwner(updated).then(sent => { if (sent) clearUpdatedFrom(DIR) }) }
// Messages the last run took but never handled (it died in between) run now. Older than 10 minutes, they are let go.
// Email needs no replay: SQS resends a mail until it is deleted after handling.
store.prune(Date.now() - 7 * 86_400_000)
// Kagelet messages the last run stored but no run read go again (runtime/kagelets.ts kageletRoutes).
routes.replay(Date.now())
const missed = store.unhandled(Date.now() - 10 * 60_000)
if (missed.length) log(`replaying ${missed.length} message${missed.length === 1 ? '' : 's'} the last run heard but never handled`)
for (const r of missed) {
  const replay = replayOf(r.connector)
  if (replay) void replay(r.source, r.payload).catch(e => log('replay failed', r.source, e))
  else { log('cannot replay', r.source, '(its connector is off)'); store.handled(r.source) }
}
log(`listening as ${slack.botUser} (@${NAME}) for ${slack.ownerName} ${slack.ids.owner}; up to ${MAX} sessions; teammates ${TEAMMATES.join(',') || 'none'}`)
// The status file `setup.sh doctor` reads follows the socket (connectors/slack.ts).
