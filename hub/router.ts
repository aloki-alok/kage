#!/usr/bin/env node
// Kage hub: wires the pieces together. Rules belong in core/; the few still here are named below.
//   connectors/  Slack, email, WhatsApp, voice: hear a message, pass the gate, hand the hub a Task
//   core/        pure rules: the gate, the dispatcher, what may go out, ledgers, hook guards
//   runtime/     where sessions run (Agent SDK by default, or tmux panes), the socket, the store
// Still here: thread trust (noteTrust), how each connector shows a failure (failed), the daily
// "still waiting" note, the self-restart into a newer build, and the auto-update that pulls one.
// plugin/server.ts is the other end for tmux panes only: the Kage channel inside each pane's Claude Code.
import { execFileSync, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import { load } from './config.ts'
import { log, logKey } from '../runtime/log.ts'
import { listenForCommands } from '../connectors/slack-commands.ts'
import { connectSlack } from '../connectors/slack.ts'
import { jevAfk, jevCheck, jevTriage } from '../connectors/jev.ts'
import { jevConfig } from '../core/jev.ts'
import { connectBrowser } from '../connectors/browser.ts'
import { blockList, unreadableBlocks } from '../core/browser.ts'
import { memoryDirs } from '../core/guards.ts'
import { protectConfig } from '../runtime/path-guards.ts'
import { stopLine } from '../core/board.ts'
import { modelFor, placeFor, sessionKey, type Conversation, type Lane } from '../core/conversations.ts'
import { mayStop, senderOf } from '../core/gate.ts'
import { Dispatcher, mixRunners } from '../core/sessions.ts'
import { readSettings, setKey, sweepImported } from '../runtime/config-files.ts'
import { configWatcher } from '../runtime/config-watch.ts'
import { DEFAULT_MODEL, unknownNames } from '../core/config.ts'
import type { Task } from '../core/task.ts'
import type { ToSession } from '../runtime/protocol.ts'
import { postAsKage, sessionTools } from '../runtime/kage-tools.ts'
import { scheduler } from '../runtime/scheduler.ts'
import { runJobs } from '../runtime/jobs.ts'
import { sdkSessions } from '../runtime/sdk-sessions.ts'
import { answerDeferred, deferredApprovals } from '../runtime/deferred-approvals.ts'
import { limitPause } from '../runtime/limit-pause.ts'
import { findPlugin, ssmRelay } from '../runtime/ssm-relay.ts'
import { keyProxy } from '../runtime/key-proxy.ts'
import { askSocket } from '../runtime/hub-client.ts'
import { listenForSessions, restoreHolds, routeReply } from '../runtime/session-link.ts'
import { openStore, type Inbox } from '../runtime/store.ts'
import { costRecorder, openLedgers, runEvents } from '../runtime/ledger.ts'
import { EVENT_DAYS } from '../core/events.ts'
import { claudeProject, tmuxPanes } from '../runtime/tmux-panes.ts'
import { clearUpdatedFrom, updatedNote } from '../runtime/auto-update.ts'
import { readCommand } from '../runtime/kagelet-manager.ts'
import { kageletDeliver } from '../runtime/kagelet-notes.ts'
import { hubLock } from '../runtime/hub-lock.ts'
import { rotate } from '../runtime/hub-log.ts'
import { hubKagelets } from './kagelets.ts'
import { ownerCommands } from './owner-commands.ts'
import { startConnectors } from './connectors.ts'
import { hubUpdates } from './updates.ts'
import { ownerDigests } from './owner-digests.ts'
import { dreams } from './dreams.ts'
import { closedThreads } from '../runtime/closed-threads.ts'
import { checkScopes } from '../runtime/slack-scopes.ts'
import { scopeDm } from '../core/slack-scopes.ts'
import { startTelemetry } from './telemetry.ts'

const { ENV_FILE, NAME, Title, TEAMMATES, TRUSTED_APPS, config, secrets, bot, user } = load()
const { harness = {}, kagelets: kl = {}, afk = {}, connectors: conn = {} } = config
const DIR = dirname(ENV_FILE)
const CODE = dirname(dirname(fileURLToPath(import.meta.url)))   // the repo root: this file is in hub/
// One hub per machine, checked before the store and Slack: two hubs on one Slack app split its events. A hub
// that answers on the socket in 2 s is running, so this one exits 0 and its supervisor leaves it down. A bare
// connect is not enough, because a hung hub still takes connects.
if (await askSocket(`${DIR}/router.sock`, { type: 'board' }, 2000).then(() => true, () => false)) {
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
const MAX = harness.maxSessions || 4
const IDLE_MIN = harness.idleMinutes || 30
process.on('unhandledRejection', e => log('unhandled', e))
// Every way the hub ends says why in the log: a signal (kage restart or stop), or a crash. An unhandled
// promise only logs: the hub keeps running.
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.on(sig, () => { log(`stopped by ${sig}`); process.exit(0) })
process.on('uncaughtException', e => { log('crashed', e); process.exit(1) })
const COMMANDS = new Map<string, string>(Object.entries(conn.commands ?? {}))

// One SQLite file holds every conversation seen and the session working on each (runtime/store.ts).
const store = openStore(`${DIR}/kage.db`)
// A card that waited outside its session (#177): the owner's answer starts a turn in that thread, which retries the call or drops it.
const deferred = deferredApprovals(store)
const answerCard = (id: string, behavior: 'allow' | 'deny', always?: true) => answerDeferred(deferred, (key, task) => { if (toSession(key, task) === 'failed') failed(task) }, id, behavior, Date.now(), always && (c => kag.alwaysAllow(c.key, c.tool, c.input)))
const SSM_SOCK = `${DIR}/ssm.sock`, SSM_SHIM = `${CODE}/cli/ssm-plugin-shim`
const ssm = ssmRelay({ path: SSM_SOCK, plugin: findPlugin(undefined, [SSM_SHIM]), trusted: key => store.relayOk(key), log })
const KEYS_SOCK = `${DIR}/keys.sock`
const keys = keyProxy({ path: KEYS_SOCK, routes: config.sessionKeys ?? {}, trusted: key => store.relayOk(key), log })   // the same allow list as the SSM relay
// What connectors keep across a restart, in the same file. The old JSON files move in once.
store.importState({ afk: `${DIR}/afk.json`, 'github-threads': `${DIR}/github-threads.json`, 'mail-threads': `${DIR}/mail-threads.json` })
// What Kage posted, waits on, spent and ran, in the same file (runtime/ledger.ts). Old .tsv files move in once.
const ledgers = openLedgers(DIR, undefined, line => log(line), (name, cells) => { if (name === 'posted' && cells[3]) runs.posted(cells[3]) })
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
  log(`task for ${place} (${logKey(key)}): ${task.fromOwner ? 'from the owner' : 'not from the owner'}${task.scheduled ? ', scheduled' : ''}, ${d.saved()[key] ? 'resumes its session' : 'new session'}`)
  return toSession(key, task)
}
// kage stop <thread> and "@kage stop": end a thread's session and its side lanes, after their turn or now.
// Messages no session read are let go.
function stopThread(key: string, cut: boolean): string {
  const now = Date.now()
  const end = (k: string) => {
    const r = d.endThread(k, cut)
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
    e => log('could not post the block line', logKey(key), e?.data?.error ?? e)),
  tellOwner: text => void slack.notifyOwner(text),
})
// A thread is owner-trusted while every task it got came from the owner by Slack (not email or voice); a schedule set up
// there runs with owner trust, anywhere else with a teammate's. Kept in the store so a restart keeps
// it. A thread with a session from before this was recorded starts untrusted: its history is unknown.
const noteTrust = (key: string, t: Task) =>
  t.need || store.noteTask(key, senderOf(t) === 'owner', key in d.saved())   // a kagelet's need is no person's task
// AFK's P0 call, the same route as `kage call` (cli/call.ts): a one-time code, then the dialer.
// The dialer may pass $KAGE_CALL_REASON to the voice agent. Resolves '' once placed, else why not.
function phoneOwner(reason: string): Promise<string> {
  const command = conn.call?.command
  if (!command) return Promise.resolve('no connectors.call.command')
  if (!voice) return Promise.resolve('voice is off (voiceToken)')
  const p = spawn(command, { shell: true, stdio: 'ignore', env: { ...process.env, KAGE_CALL_CODE: voice.issueCode(), KAGE_CALL_REASON: reason.slice(0, 300) } })
  const timer = setTimeout(() => p.kill(), 60_000)   // a dialer that hangs reports as failed
  return new Promise(res => { p.on('error', e => res(String(e))); p.on('close', code => { clearTimeout(timer); res(code === 0 ? '' : `dialer exited ${code ?? 'on timeout'}`) }) })
}
// The Jev classifier for agent posts (core/jev.ts). A wrong setting leaves it off and says why, so Kage still starts.
const jev = jevConfig(config.jev, secrets.jevKey)
if (jev && 'error' in jev) log(`jev is off: ${jev.error}`)
else if (jev) log(`jev checks ${jev.agents === 'all' ? 'every listed agent' : jev.agents.join(', ')} at threshold ${jev.threshold}`)

const slack = await connectSlack({
  catchUpMax: () => config.tripwires?.catchUpMax || 1000, dir: DIR, appToken: secrets.slack!.app!, userToken: secrets.slack!.user!, bot, user, name: NAME, title: Title, teammates: TEAMMATES, apps: TRUSTED_APPS,
  hub: { deliver, stop: (c, cut, by) => {
      const key = sessionKey(c, { lane: 'main' })
      return mayStop(by, slack.ids.owner, starters, key) ? stopThread(key, cut) : 'Only the owner, or the teammate whose task started this thread, can stop it.'
    }, verdict: (id, behavior, always) => d.verdict(id, { type: 'verdict', request_id: id, behavior }) || answerCard(id, behavior, always), status: () => commands.status(), heard: m => schedules.heard(m), channelPost: p => jobs.channelPost(p), channelCatchUp: h => jobs.channelCatchUp(h), channelGap: () => jobs.channelGap(),
    posted: () => ledgers.text('posted'), kageletsIn: (chat, thread) => kag.peopleIn(chat, thread), kageletAsk: (chat, thread, name, from, text) => kag.ask(chat, thread, name, from, text), ownerWrote: (chat, thread, text) => { for (const k of kag.notes.wrote(kag.lanes(), chat, thread, text)) runs.emit(k, 'owner-note', `${text.length} characters`) }, ...inbox },
  // AFK mode is on unless afk.on is false. Its stand-in reads the owner's memory, read only.
  jev: jev && !('error' in jev) ? jevCheck(jev) : undefined, ackWords: config.jev?.ackWords !== false,
  triage: jev && !('error' in jev) ? jevTriage(jev, (who, detail) => runs.emit(who, 'triage', detail)) : undefined,
  afk: afk.on === false ? undefined : { memory: memoryDirs(process.env.HOME!, ENV_FILE, harness).owner, model: afk.model || DEFAULT_MODEL, saved: store, call: phoneOwner, jev: jev && !('error' in jev) ? jevAfk(jev) : undefined },
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
  settings: () => ({ autoMemoryDirectory: MEM.own, ...protectConfig(ENV_FILE, CODE, undefined, config.harness?.sandbox === true) }),
  ssm: { sock: SSM_SOCK, shim: SSM_SHIM, issue: key => ssm.issue(key), drop: key => ssm.drop(key) },
  idOf: key => d.saved()[key],
  placeOf,
  onStart: () => store.saveSessions(d.saved()),
})
// Each thread runs as an Agent SDK session inside this process, unless harness.runtime is tmux gives it a
// tmux pane. A missing SDK package falls back to panes.
// Panes still running when the hub starts keep their thread (and their CronCreate jobs) until they
// close; see mixRunners.
const MEM = memoryDirs(process.env.HOME!, ENV_FILE, harness)
const PROJECT = claudeProject(process.cwd())   // both runners start sessions in the hub's folder, so transcripts live here
// What each turn cost (runtime/ledger.ts costRecorder): `kage cost`, the kagelet caps and the cost flags read it.
const recordCost = costRecorder(ledgers)
// Kage in Chrome (#114): the owner's own browser, through Kage's extension, for the owner's own tasks only.
rmSync(`${DIR}/browser-seen`, { force: true })   // a poll the last hub heard says nothing about this one
let seenVersion: string | undefined
let browserSeen = 0   // kage doctor reads browser-seen; written at most every 30 s, since the extension polls about every 25 s
const browser = secrets.browserToken ? connectBrowser({ token: secrets.browserToken, port: conn.browser?.port || 8791,
  onPoll: (at, v) => { if (at - browserSeen >= 30_000 || v !== seenVersion) { browserSeen = at; seenVersion = v; writeFileSync(`${DIR}/browser-seen`, `${at} ${v ?? ''}`.trim(), { mode: 0o600 }) } } }) : undefined
void browser?.listening.then(port => log(`browser on: 127.0.0.1:${port}/browser`), e => log('browser could not listen', e))
const browserBlock = (conn.browser?.block ?? []).join(',')
const BROWSER_BLOCK = blockList(browserBlock)
for (const e of unreadableBlocks(browserBlock)) log(`connectors.browser.block: "${e}" is not a site, so it blocks nothing`)
const sdkLib = harness.runtime === 'tmux' ? undefined : await (async () => ({
  lib: await import('@anthropic-ai/claude-agent-sdk'),
  // The same pinned Claude Code the panes run, not the copy bundled with the SDK.
  claude: execFileSync('/bin/sh', ['-c', 'command -v claude'], { encoding: 'utf8' }).trim(),
}))().catch((e: Error) => {
  console.error(`Agent SDK not usable (${e.message}), so threads open as tmux panes. Run npm ci, then restart.`)
  return undefined
})
// Kagelets (#57), their memory, the manager's side and the chains between them (hub/kagelets.ts).
const kag = hubKagelets({ dir: DIR, kl, mem: MEM, store, ledgers, runs, title: Title, notify: text => void slack.notifyOwner(text), hasSdk: () => !!sdk,
  runNow: (id, now) => schedules.runNow(id, now), toSession: (key, task) => toSession(key, task),
  idle: key => !isClosed(key) && d.ready(key) === 'ready' && d.startsNow(key, Date.now()), paused: now => limits.paused(now)?.until, tripwires: () => config.tripwires })
const sdk = sdkLib ? sdkSessions({
  sdk: sdkLib.lib,
  deferred,
  hub: () => d,
  tools: (key, send, approve) => sessionTools({
    title: Title, bot, user, botDm: () => slack.ids.botDm, dir: DIR, ledgers, send, memory: MEM,
    schedules: { add: j => jobs.add(key, j, Date.now()), remove: id => jobs.remove(key, id), list: () => schedules.list(key), hookUrl: id => jobs.hookUrl(id), tune: (id, t) => schedules.tune(key, id, t, Date.now()), restore: id => jobs.swaps.restore(key, id, Date.now()), move: (id, to) => schedules.move(key, id, to, Date.now()) },
    afk: slack.afk?.command,
    settings: { set: (key, value) => setKey(ENV_FILE, key, value) },
    kagelet: key.split('#side-kagelet-')[1], dreaming: key.split('#side-kdream-')[1], kageletMemory: kag.kmem,
    browser: browser && { call: browser.call, block: BROWSER_BLOCK },
    meetbot: meeting && { join: meeting.join },
    dbRead: { command: () => readCommand(kl.dbRead?.command ?? undefined, store, key.split('#side-kagelet-')[1] ?? ''), maxRows: kl.dbRead?.maxRows || 200 },
    kagelets: { list: () => kag.manager.list(Date.now()), manage: (a, ask) => kag.manager.manage(a, Date.now(), ask) }, approve,
    event: (kind, detail) => runs.emit(key, kind, detail),
    onReport: r => kag.routes.reported(key, r), message: (to, text) => kag.routes.message(key, to, text), toManager: needs => kag.needs.add(key, key.split('#side-kagelet-')[1] ?? '', needs, Date.now()), tellKagelet: (name, text, now) => kag.tell(name, text, now),
  }),
  hasTranscript: tmux.hasTranscript,
  toHub: (key, m) => routeReply(key, m, replies),
  options: {
    cwd: process.cwd(),
    settingSources: ['user', 'project', 'local'],
    // The shipped skills (skills/ at the repo root) load in every session, as kage:<name>, whatever the owner has installed.
    plugins: [{ type: 'local' as const, path: CODE }],
    settings: { autoMemoryDirectory: MEM.own },
    pathToClaudeCodeExecutable: sdkLib.claude,
  },
  ownerMemory: MEM.owner, sharedTools: config.sharedTools,
  envFile: ENV_FILE,
  codeDir: CODE, sandbox: () => config.harness?.sandbox === true,
  ssm: { sock: SSM_SOCK, shim: SSM_SHIM, issue: key => ssm.issue(key), drop: key => ssm.drop(key) },
  keys: { sock: KEYS_SOCK, issue: key => keys.issue(key), drop: key => keys.drop(key) },
  onStart: () => store.saveSessions(d.saved()),
  onResult: (key, total, resumed, limited) => {
    const usd = recordCost(key, total, resumed)
    kag.routes.ended(key, usd ?? 0, d.saved()[key] ? `${PROJECT}/${d.saved()[key]}.jsonl` : '', Date.now(), limited)
  },
  budgetOf: kag.budgetOf,
  modelOf: key => modelFor(key, config.harness?.jobModel, k => k.includes('#side-kdream-') ? DEFAULT_MODEL : k.startsWith('voice:') && config.connectors?.voice?.model ? config.connectors.voice.model : kag.modelOf(k)),
  onBlocked: blocked,
  onTurn: (key, tasks, limit, done) => limits.turn(key, tasks, limit, Date.now(), done),
  // A lane whose file is gone keeps no tools, rather than falling back to approval cards.
  grantOf: kag.grantOf, allowOf: kag.allowOf, reviewHeld: kag.reviewHeld,
  onTool: (key, tool, refused) => runs.emit(key, refused ? 'refusal' : 'tool', refused ? `${tool}: ${refused}` : tool),
}) : undefined
if (sdk) mkdirSync(MEM.own, { recursive: true })
kag.sync(Date.now())

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
  store, log, event: detail => ledgers.event({ kind: 'limit', who: 'hub', trace: '', detail }), settle: (tasks, done) => { kag.routes.settle(tasks, done); kag.needs.settle(tasks, done) },
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
restoreHolds(DIR, d)
// Schedules live in the store and run as tasks in their thread (runtime/scheduler.ts).
const schedules = scheduler({
  store, failed,
  deliver: kageletDeliver(kag.notes, toSession, kag.board),
  ready: key => d.ready(key),
  trusted: key => store.trust(key) === true, job: { end: k => d.reset(k), project: PROJECT, carryChars: () => config.harness?.jobCarryChars ?? 500, laneDefault: () => config.harness?.jobLaneDefault ?? true, freshEvery: () => config.harness?.jobFreshEvery ?? 20, carryCount: () => config.harness?.jobCarry ?? 5, posted: () => ledgers.text('posted') },
  ran: j => ledgers.add('runs', [j.id, j.key]),
  tripwires: () => config.tripwires ?? {}, event: e => ledgers.event(e), owner: t => void slack.notifyOwner(t), ping: async (s, text) => { const c = store.conversation(s.key)?.conversation; if (!c) return false; return postAsKage({ title: Title, bot, user }, c.chat, c.thread, text).then(r => { ledgers.add('posted', [c.chat, r.ts, r.by, s.key]); return true }, e => { log('could not post a tripwire ping', s.id, e?.data?.error ?? e); return false }) },
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

const { meeting, voice, replies, replayOf, jobs, clock } = startConnectors({ secrets, conn, store, slack, bot, NAME, CODE, DIR, d, inbox, deliver, placeOf, failed, schedules, event: ledgers.event, ledgers, tripwires: config.tripwires })
listenForCommands(slack.socket, { user, team: slack.ids.team!, commands: COMMANDS, ledgers })

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

const digests = ownerDigests({ dir: DIR, ledgers, store, placeOf, costTracked: !!sdk, expireHours: () => config.waiting?.expireHours ?? 72, notify: t => slack.notifyOwner(t) })
const dreaming = dreams({ dir: DIR, code: CODE, title: Title, botDm: slack.ids.botDm, mem: MEM, project: PROJECT, kagelets: kag.dir, kmem: kag.kmem, hasSdk: !!sdk,
  store, ledgers, placeOf, paused: () => !!limits.paused(), quiet: now => d.quietEverywhere(now), deliver, toSession })
const updates = hubUpdates({ code: CODE, dir: DIR, ledgers, quiet: now => d.quietEverywhere(now) && !limits.paused(now), notify: t => slack.notifyOwner(t) })
const VERSION = updates.VERSION

// Every timed job of the hub, on one clock (runtime/jobs.ts).
runJobs([
  // A drain for kage restart or stop starts no scheduled run: one due now runs after the restart.
  { name: 'schedules', every: 20_000, run: now => { if (!limits.draining(now)) schedules.tick(now); jobs.swaps.tick(now) } },
  { name: 'sweep', every: 60_000, run: now => d.sweep(now).forEach(failed) },
  { name: 'limit pause', every: 20_000, run: now => limits.tick(now) },
  { name: 'daily note', every: 10 * 60_000, run: digests.dailyNote },
  { name: 'self-update', every: 60_000, run: updates.selfUpdate },
  ...config.autoUpdate === false ? [] : [{ name: 'auto-update', every: 6 * 3_600_000, run: updates.autoUpdate }],
  { name: 'auto-release', every: 3_600_000, run: updates.autoRelease },
  // hub.ts rotates the log at each start; a hub that runs for weeks rotates it here.
  { name: 'hub-log', every: 3_600_000, run: () => rotate(`${DIR}/hub.log`) },
  { name: 'kagelets', every: 60_000, run: kag.sync },
  { name: 'dream', every: 10 * 60_000, run: dreaming.dream },
  { name: 'kagelet dreams', every: 10 * 60_000, run: dreaming.kageletDreams },
  { name: 'retro', every: 10 * 60_000, run: digests.weeklyRetro }, ...clock,
  // A kagelet message waits until its target is idle, then starts a run of its own (runtime/kagelets.ts).
  { name: 'kagelet messages', every: 20_000, run: now => { kag.routes.pump(now); kag.needs.pump(now); kag.measure(now) } },
  { name: 'events', every: 3_600_000, run: now => ledgers.pruneEvents(new Date(now - EVENT_DAYS * 86_400_000).toISOString()) }, ...startTelemetry({ config: config.telemetry, dir: DIR, code: CODE, ledgers, state: store, notify: t => slack.notifyOwner(t), usage: sdk?.usage, shape: () => { const s = store.schedules(); return { email: +!!conn.email?.on, voice: +!!conn.voice?.on, whatsapp: +!!conn.whatsapp?.on, github: +!!conn.github, meeting: +!!conn.meeting, browser: +!!conn.browser, schedules: s.length, tripwires: s.filter(j => j.trigger).length, kagelets: [...kag.lanes()].length, teammates: TEAMMATES.length } } }),
])

const commands = ownerCommands({ d, store, ledgers, limits, MAX, placeOf, closedTo, noteTrust, failed, dropRelay: key => { ssm.drop(key); keys.drop(key) } })
// Changed settings (runtime/config-watch.ts): the people lists apply to the next message with no turn cut, any other key
// restarts the hub once every session is quiet (selfUpdate below), and a wrong file is refused. kage reload runs the same check.
const watcher = configWatcher({
  envFile: ENV_FILE, boot: { config, secrets }, log, apply: slack.allow, tell: text => void slack.notifyOwner(text),
  event: (kind, keys) => ledgers.event({ kind, who: 'config', trace: '', detail: keys.join(', ') }),
  restartWanted: yes => updates.restartWanted(yes),
})
const reload = watcher.check
listenForSessions(`${DIR}/router.sock`, d, { ...replies, failed, schedules: jobs, tell: commands.tell, relay: commands.relay, reload, paused: () => limits.paused(), limitCounts: () => limits.counts,
  // kage restart and stop: a drain renewed by each ask. A turn that just ended does not hold them up: its follow-up
  // waits too. Nor does a thread open in a terminal: kage attach holds it again after the restart.
  end: (key, cut) => stopThread(key, cut), kagelet: (action, name) => kag.manager.manage({ action, name }, Date.now()),
  quiesce: () => { const now = Date.now(); limits.drain(now); return d.unquiet(now).filter(u => u.why !== 'just active' && u.why !== 'open in a terminal') }, callCode: voice?.issueCode })

await slack.start()
// Imported env files hold every token. Slack connected means this start is clean, not a crash loop: delete the ones older than 7 days.
try { for (const f of sweepImported(ENV_FILE)) log(`deleted ${f}, 7 days after the import`) } catch (e) { log(`could not sweep old env files: ${e}`) }
const updated = updatedNote(DIR, CODE, VERSION)
if (updated) { log(updated); void slack.notifyOwner(updated).then(sent => { if (sent) clearUpdatedFrom(DIR) }) }
// Env lines the import could not place sit under "unknown" in config.json. The owner hears their names (never values) once per set.
const unplaced = unknownNames(readSettings(ENV_FILE).config).join(', ')
const told = `${DIR}/config-unknown-told`
if (unplaced && (existsSync(told) ? readFileSync(told, 'utf8') : '') !== unplaced) {
  void slack.notifyOwner(`Kage moved its settings into config.json. It could not place these old lines, so they sit under "unknown": ${unplaced}. Tell me what each one is for, and I will help place it.`)
    .then(sent => { if (sent) writeFileSync(told, unplaced) })
}
// An app keeps the scopes of the manifest it was made from. The owner hears each distinct missing set once (kage slack upgrade fixes it).
const SCOPES_TOLD = 'slack-scopes-told'
void checkScopes({ user: secrets.slack?.user, bot: secrets.slack?.bot }).then(m => {
  const { send, told } = scopeDm(m, store.load(SCOPES_TOLD) as string | undefined)
  if (send) void slack.notifyOwner(send).then(sent => { if (sent) store.save(SCOPES_TOLD, told) })
  else store.save(SCOPES_TOLD, told)
}).catch(e => log(`scope check failed: ${e}`))
// Messages the last run took but never handled (it died in between) run now. Older than 10 minutes, they are let go.
// Email needs no replay: SQS resends a mail until it is deleted after handling.
store.prune(Date.now() - 7 * 86_400_000)
// Kagelet messages the last run stored but no run read go again (runtime/kagelets.ts kageletRoutes).
kag.routes.replay(Date.now()); kag.needs.replay(Date.now())
const missed = store.unhandled(Date.now() - 10 * 60_000)
if (missed.length) log(`replaying ${missed.length} message${missed.length === 1 ? '' : 's'} the last run heard but never handled`)
for (const r of missed) {
  const replay = replayOf(r.connector)
  if (replay) void replay(r.source, r.payload).catch(e => log('replay failed', r.source, e))
  else { log('cannot replay', r.source, '(its connector is off)'); store.handled(r.source) }
}
log(`listening as ${slack.botUser} (@${NAME}) for ${slack.ownerName} ${slack.ids.owner}; up to ${MAX} sessions; teammates ${TEAMMATES.join(',') || 'none'}`)
// The status file `setup.sh doctor` reads follows the socket (connectors/slack.ts).
