#!/usr/bin/env node
// Kage hub: wires the pieces together. Rules belong in core/; the few still here are named below.
//   connectors/  Slack, email, WhatsApp, voice: hear a message, pass the gate, hand the hub a Task
//   core/        pure rules: the gate, the dispatcher, what may go out, ledgers, hook guards
//   runtime/     where sessions run (Agent SDK by default, or tmux panes), the socket, the store
// Still here: thread trust (noteTrust), how each connector shows a failure (failed), the daily
// "still waiting" note, and the self-restart into a newer build.
// server.ts is the other end for tmux panes only: the Kage channel inside each pane's Claude Code.
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import { load, log } from './config.ts'
import { connectEmail } from './connectors/email.ts'
import { listenForCommands } from './connectors/slack-commands.ts'
import { connectSlack } from './connectors/slack.ts'
import { connectVoice } from './connectors/voice.ts'
import { startWhatsApp } from './connectors/whatsapp-link.ts'
import { parseCommands } from './core/commands.ts'
import { memoryDirs } from './core/guards.ts'
import { sessionKey, type Conversation, type Lane } from './core/conversations.ts'
import { senderOf } from './core/gate.ts'
import { dailyDue, openWaiting, staleWaiting } from './core/ledgers.ts'
import { Dispatcher, mixRunners } from './core/sessions.ts'
import type { Task, ToSession } from './runtime/protocol.ts'
import { sessionTools } from './runtime/kage-tools.ts'
import { scheduler } from './runtime/scheduler.ts'
import { sdkSessions } from './runtime/sdk-sessions.ts'
import { listenForSessions, restoreHolds, routeReply } from './runtime/session-link.ts'
import { openStore } from './runtime/store.ts'
import { tmuxPanes } from './runtime/tmux-panes.ts'
import { codeStamp } from './runtime/code-stamp.ts'

const { ENV_FILE, NAME, Title, TEAMMATES, env, need, bot, user } = load()
const DIR = dirname(ENV_FILE)
const THREADS = `${DIR}/threads.json`
// start.sh sets the command that starts Claude Code with the kage channel.
const CLAUDE = process.env.KAGE_CLAUDE || (log('KAGE_CLAUDE is not set: start Kage with ./start.sh'), process.exit(1))
const MAX = Number(env.KAGE_MAX_SESSIONS || 4)
const IDLE_MIN = Number(env.KAGE_IDLE_MINUTES || 30)
process.on('unhandledRejection', e => log('unhandled', e))
let COMMANDS: Map<string, string>
try { COMMANDS = parseCommands(env.KAGE_COMMANDS || '') } catch (e) { log(String(e)); process.exit(1) }

// One SQLite file holds every conversation seen and the session working on each (runtime/store.ts).
const store = openStore(`${DIR}/kage.db`)
const placeOf = (key: string) => store.conversation(key)?.place ?? key

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
const slack = await connectSlack({
  dir: DIR, appToken: need('SLACK_APP_TOKEN'), bot, user, name: NAME, title: Title, teammates: TEAMMATES,
  hub: { deliver, verdict: (id, behavior) => d.verdict(id, { type: 'verdict', request_id: id, behavior }), status },
  // AFK mode is on unless KAGE_AFK=off. Its stand-in reads the owner's memory, read only.
  afk: env.KAGE_AFK === 'off' ? undefined : { memory: memoryDirs(process.env.HOME!, ENV_FILE, env).owner, model: env.KAGE_AFK_MODEL || 'sonnet' },
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
const sdk = sdkLib ? sdkSessions({
  sdk: sdkLib.lib,
  hub: () => d,
  tools: (key, send) => sessionTools({
    title: Title, bot, user, botDm: () => slack.ids.botDm, dir: DIR, send, memory: MEM,
    schedules: { add: j => schedules.add(key, j, Date.now()), remove: id => schedules.remove(key, id), list: () => schedules.list(key) },
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
})
setInterval(() => { try { schedules.tick(Date.now()) } catch (e) { log('schedule tick failed', e) } }, 20_000)
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
const WAITING = `${DIR}/waiting.tsv`
function status(): string {
  const s = d.status(Date.now())
  const min = (ms: number) => `${Math.round(ms / 60_000)} min`
  const lines = s.live.map(l => `• ${placeOf(l.key)}: ${l.state}${l.state === 'quiet' ? ` for ${min(l.quietMs)}` : ''}`)
  const open = openWaiting(readFile(WAITING)).length
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
setInterval(async () => {
  const today = dailyDue(Date.now(), readFile(DAILY).trim() || undefined)
  if (!today) return
  const stale = staleWaiting(readFile(WAITING), Date.now(), 24 * 3600_000)
  const sent = !stale.length || await slack.notifyOwner([`*Still waiting on you (${stale.length})*`,
    ...stale.map(i => `• ${i.link ? `<${i.link}|${i.what}>` : i.what} (since ${i.when.slice(0, 10)})`)].join('\n'))
  // Marked only once the note went out (or there was nothing to say), so a failed post retries.
  if (sent) writeFileSync(DAILY, today, { mode: 0o600 })
}, 10 * 60_000)
const email = connectEmail({
  env, dir: DIR, name: NAME, deliver,
  failed: task => void slack.notifyOwner(`Could not start a session for ${task.meta.place}.`),
})
// Voice is on when KAGE_VOICE_TOKEN is set, unless KAGE_VOICE=off. A voice agent reaches it over a tunnel.
const voice = connectVoice({
  env, name: NAME, deliver,
  end: key => { if (key.startsWith('voice:')) d.end(key) },   // only the call's own session
  slot: key => d.hasFreeSlot(key),   // a call never evicts or queues ahead of the owner's threads
  failed: task => void slack.notifyOwner(`Could not start a session for ${task.meta.place}.`),
})
listenForCommands(slack.socket, { user, team: slack.ids.team!, commands: COMMANDS, logFile: `${DIR}/commands.tsv` })

// WhatsApp is on when Kage's WAHA config exists, unless KAGE_WHATSAPP=off (the kill switch).
const whatsapp = env.KAGE_WHATSAPP !== 'off' && existsSync(`${DIR}/waha/.env`) ? startWhatsApp({
  dir: DIR, name: NAME, owner: slack.ownerName, env,
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
setInterval(() => { try { d.sweep(Date.now()).forEach(failed) } catch (e) { log('sweep failed', e) } }, 60_000)

// Kage updates itself: newer code (a merge, a pull, the install line again) takes over once
// nothing would be cut off. The loop start.sh runs the hub in starts it again 5s after it exits.
// ponytail: a live cron job inside the hub (SDK) counts as busy, so it delays the update; restart by hand then. A pane outlives the hub.
// The change must be settled for 10s, so a merge still writing files is never picked up half-done.
// Compared to the boot stamp, not the clock, so a file with a future time cannot restart the hub over and over.
const CODE = dirname(fileURLToPath(import.meta.url))
const BOOT_CODE = codeStamp(CODE)
setInterval(() => {
  const code = codeStamp(CODE)
  if (code && code !== BOOT_CODE && Date.now() - code > 10_000 && d.quietEverywhere(Date.now())) {
    log('newer code is in place and every session is quiet: restarting into it')
    process.exit(0)
  }
}, 60_000)

const replies = {
  voice: (key: string, text: string) => voice?.reply(key, text),
  wa: (key: string, text: string) => void whatsapp?.(key, text).catch(e => log('whatsapp send failed', key, e)),
  mail: (key: string, text: string) => void email?.send(key, text).catch(e => {
    log('mail reply failed', key, e)
    void slack.notifyOwner(`Email reply failed for ${placeOf(key)}: ${e}`)
  }),
}
listenForSessions(`${DIR}/router.sock`, d, { ...replies, failed, schedules, callCode: voice?.issueCode })

await slack.start()
log(`listening as ${slack.botUser} (@${NAME}) for ${slack.ownerName} ${slack.ids.owner}; up to ${MAX} sessions; teammates ${TEAMMATES.join(',') || 'none'}`)
// `setup.sh doctor` reads this to prove the hub reached Slack.
writeFileSync(`${DIR}/status`, `connected ${new Date().toISOString()} pid ${process.pid} as @${NAME}\n`, { mode: 0o600 })
