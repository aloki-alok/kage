#!/usr/bin/env node
// Kage hub: wires the pieces together. Rules belong in core/; the few still here are named below.
//   connectors/  Slack, email, WhatsApp, voice: hear a message, pass the gate, hand the hub a Task
//   core/        pure rules: the gate, the dispatcher, what may go out, ledgers, hook guards
//   runtime/     where sessions run (Agent SDK by default, or tmux panes), the socket, the store
// Still here: thread trust (noteTrust), how each connector shows a failure (failed), the daily
// "still waiting" note, and the self-restart into a newer build.
// server.ts is the other end for tmux panes only: the Kage channel inside each pane's Claude Code.
import { execFileSync, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import { load, log } from './config.ts'
import { connectEmail } from './connectors/email.ts'
import { listenForCommands } from './connectors/slack-commands.ts'
import { connectSlack } from './connectors/slack.ts'
import { connectGithub } from './connectors/github.ts'
import { connectVoice } from './connectors/voice.ts'
import { startWhatsApp } from './connectors/whatsapp-link.ts'
import { parseCommands } from './core/commands.ts'
import { memoryDirs } from './core/guards.ts'
import { placeFor, sessionKey, type Conversation, type Lane } from './core/conversations.ts'
import { senderOf } from './core/gate.ts'
import { dailyDue, lastTotals, openWaiting, staleWaiting, turnCost } from './core/ledgers.ts'
import { dreamDue, dreamTask, threadsSince } from './core/dream.ts'
import { retro, retroDue } from './core/retro.ts'
import { Dispatcher, mixRunners } from './core/sessions.ts'
import type { Task, ToSession } from './runtime/protocol.ts'
import { sessionTools } from './runtime/kage-tools.ts'
import { scheduler } from './runtime/scheduler.ts'
import { runJobs } from './runtime/jobs.ts'
import { snapshotMemory } from './runtime/memory-snapshot.ts'
import { sdkSessions } from './runtime/sdk-sessions.ts'
import { listenForSessions, restoreHolds, routeReply } from './runtime/session-link.ts'
import { openStore, type Inbox } from './runtime/store.ts'
import { openLedgers } from './runtime/ledger.ts'
import { claudeProject, tmuxPanes } from './runtime/tmux-panes.ts'
import { codeStamp } from './runtime/code-stamp.ts'

const { ENV_FILE, NAME, Title, TEAMMATES, env, need, bot, user } = load()
const DIR = dirname(ENV_FILE)
const THREADS = `${DIR}/threads.json`
// start.sh sets the command that starts Claude Code with the kage channel.
const CLAUDE = process.env.KAGE_CLAUDE || (log('KAGE_CLAUDE is not set: start Kage with ./start.sh'), process.exit(1))
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
const placeOf = (key: string) => placeFor(k => store.conversation(k)?.place, key)
// Every connector writes what it hears here before acknowledging it (runtime/store.ts, the inbox).
const inbox: Inbox = { take: (source, connector, payload) => store.take(source, connector, payload, Date.now()), handled: source => store.handled(source), has: source => store.has(source) }

// Connectors hand the hub a conversation; the hub alone turns it into a session key.
const deliver = (c: Conversation, task: Task, place: string, lane: Lane = 'main') => {
  const key = sessionKey(c, { lane })
  store.seen(key, c, place, Date.now())
  noteTrust(key, task)
  return d.task(key, task, Date.now())
}
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
const slack = await connectSlack({
  dir: DIR, appToken: need('SLACK_APP_TOKEN'), bot, user, name: NAME, title: Title, teammates: TEAMMATES,
  hub: { deliver, verdict: (id, behavior) => d.verdict(id, { type: 'verdict', request_id: id, behavior }), status, heard: m => schedules.heard(m),
    posted: () => ledgers.text('posted'), ...inbox },
  // AFK mode is on unless KAGE_AFK=off. Its stand-in reads the owner's memory, read only.
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
const sdkLib = env.KAGE_RUNTIME === 'tmux' ? undefined : await (async () => ({
  lib: await import('@anthropic-ai/claude-agent-sdk'),
  // The same pinned Claude Code the panes run, not the copy bundled with the SDK.
  claude: execFileSync('/bin/sh', ['-c', 'command -v claude'], { encoding: 'utf8' }).trim(),
}))().catch((e: Error) => {
  console.error(`Agent SDK not usable (${e.message}), so threads open as tmux panes. Run npm ci, then restart.`)
  return undefined
})
// What each turn cost (core/ledgers.ts): `kage cost` reads it.
const costTotals = lastTotals(ledgers.text('costs'))
const sdk = sdkLib ? sdkSessions({
  sdk: sdkLib.lib,
  hub: () => d,
  tools: (key, send) => sessionTools({
    title: Title, bot, user, botDm: () => slack.ids.botDm, dir: DIR, ledgers, send, memory: MEM,
    schedules: { add: j => schedules.add(key, j, Date.now()), remove: id => schedules.remove(key, id), list: () => schedules.list(key) },
    afk: slack.afk?.command,
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
  onStart: () => store.saveSessions(d.saved()),
  onResult: (key, total, resumed) => {
    const usd = turnCost(costTotals.get(key), total, resumed)
    if (usd === undefined) return
    costTotals.set(key, total)
    ledgers.add('costs', [key, String(usd), String(total)])
  },
}) : undefined
if (sdk) mkdirSync(MEM.own, { recursive: true })

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
// Panes still running from before this hub restarted keep working.
d.adopt(Object.keys(saved).filter(k => runningAtStart.has(saved[k]!)), Date.now())
// Threads still open in a terminal (kage attach) stay held: before any connector can deliver a task.
restoreHolds(DIR, d, Date.now())
// Schedules live in the store and run as tasks in their thread (runtime/scheduler.ts).
const schedules = scheduler({
  store, failed,
  deliver: (key, task) => { noteTrust(key, task); return d.task(key, task, Date.now()) },
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
  return [
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
  const sent = !stale.length || await slack.notifyOwner([`*Still waiting on you (${stale.length})*`,
    ...stale.map(i => `• ${i.link ? `<${i.link}|${i.what}>` : i.what} (since ${i.when.slice(0, 10)})`)].join('\n'))
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
const PROJECT = claudeProject(process.cwd())   // both runners start sessions in the hub's folder
function dream(now: number) {
  const last = Number(readFile(DREAMT).trim()) || undefined
  if (!dreamDue(now, last, d.quietEverywhere(now))) return
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
  log('could not deliver to a session:', m.meta.place, m.origin.ts, `(attach: tmux attach -t ${NAME})`)
  if (!m.origin.ts) void slack.notifyOwner(`Could not start a session for a scheduled run in ${m.meta.place}.`)
  else if (m.origin.channel === 'email' || m.origin.channel === 'whatsapp' || m.origin.channel === 'voice') void slack.notifyOwner(`Could not start a session for ${m.meta.place}.`)
  else slack.failed(m)
}

// Kage updates itself: newer code (a merge, a pull, the install line again) takes over once
// nothing would be cut off. The loop start.sh runs the hub in starts it again 5s after it exits.
// ponytail: a live cron job inside the hub (SDK) counts as busy, so it delays the update; restart by hand then. A pane outlives the hub.
// The change must be settled for 10s, so a merge still writing files is never picked up half-done.
// Compared to the boot stamp, not the clock, so a file with a future time cannot restart the hub over and over.
const CODE = dirname(fileURLToPath(import.meta.url))
const BOOT_CODE = codeStamp(CODE)
function selfUpdate(now: number) {
  const code = codeStamp(CODE)
  if (code && code !== BOOT_CODE && now - code > 10_000 && d.quietEverywhere(now)) {
    log('newer code is in place and every session is quiet: restarting into it')
    process.exit(0)
  }
}

// Every timed job of the hub, on one clock (runtime/jobs.ts).
runJobs([
  { name: 'schedules', every: 20_000, run: now => schedules.tick(now) },
  { name: 'sweep', every: 60_000, run: now => d.sweep(now).forEach(failed) },
  { name: 'daily note', every: 10 * 60_000, run: dailyNote },
  { name: 'self-update', every: 60_000, run: selfUpdate },
  { name: 'dream', every: 10 * 60_000, run: dream },
  { name: 'retro', every: 10 * 60_000, run: weeklyRetro },
])

const replies = {
  voice: (key: string, text: string) => voice?.reply(key, text),
  wa: (key: string, text: string) => void whatsapp?.send(key, text).catch(e => log('whatsapp send failed', key, e)),
  mail: (key: string, text: string) => void email?.send(key, text).catch(e => {
    log('mail reply failed', key, e)
    void slack.notifyOwner(`Email reply failed for ${placeOf(key)}: ${e}`)
  }),
}
// kage tell: the owner's words into a thread, typed on this machine. Same shape as a scheduled run (runtime/scheduler.ts).
function tell(key: string, text: string): { ok: true; held?: true } | { refused: string } {
  const c = store.conversation(key)
  if (!c) return { refused: 'no thread with that key' }
  // ponytail: Slack only, like schedules; email and WhatsApp tasks need their connector's own meta, add when wanted.
  if (c.conversation.connector !== 'slack') return { refused: 'tell works on Slack threads only for now' }
  const task: Task = {
    type: 'task', fromOwner: true, content: `From the owner, typed in the terminal: ${text}`,
    meta: { channel: c.conversation.chat, thread_ts: c.conversation.thread ?? '', place: c.place, permalink: '' },
    origin: { channel: c.conversation.chat, ts: '' },
  }
  log('tell', c.place)
  noteTrust(key, task)
  const r = d.task(key, task, Date.now())
  if (r === 'failed') { failed(task); return { refused: 'could not start a session there' } }
  return r === 'held' ? { ok: true, held: true } : { ok: true }
}
listenForSessions(`${DIR}/router.sock`, d, { ...replies, failed, schedules, tell, callCode: voice?.issueCode })

await slack.start()
// Messages the last run took but never handled (it died in between) run now. Older than 10 minutes, they are let go.
// Email needs no replay: SQS resends a mail until it is deleted after handling.
store.prune(Date.now() - 7 * 86_400_000)
const missed = store.unhandled(Date.now() - 10 * 60_000)
if (missed.length) log(`replaying ${missed.length} message${missed.length === 1 ? '' : 's'} the last run heard but never handled`)
const replayers: Record<string, ((source: string, payload: string) => Promise<unknown>) | undefined> = { slack: slack.replay, github: github?.replay, whatsapp: whatsapp?.replay }
for (const r of missed) {
  const replay = replayers[r.connector]
  if (replay) void replay(r.source, r.payload).catch(e => log('replay failed', r.source, e))
  else { log('cannot replay', r.source, '(its connector is off)'); store.handled(r.source) }
}
log(`listening as ${slack.botUser} (@${NAME}) for ${slack.ownerName} ${slack.ids.owner}; up to ${MAX} sessions; teammates ${TEAMMATES.join(',') || 'none'}`)
// The status file `setup.sh doctor` reads follows the socket (connectors/slack.ts).
