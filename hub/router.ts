#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process'
import { waCards } from '../runtime/wa-cards.ts'
import { waCardNote } from '../core/whatsapp.ts'
import { ownerChannel } from '../core/owner-channel.ts'
import { wahaToOwner, wahaUrl } from '../connectors/whatsapp.ts'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import { load } from './config.ts'
import { log, logKey } from '../runtime/log.ts'
import { listenForCommands } from '../connectors/slack/commands.ts'
import { connectSlack } from '../connectors/slack/connect.ts'
import { jevAfk, jevCheck, jevTriage } from '../connectors/jev.ts'
import { jevConfig } from '../core/jev.ts'
import { connectBrowser } from '../connectors/browser.ts'
import { screenRecorder } from '../runtime/screen.ts'
import { blockList, unreadableBlocks } from '../core/browser.ts'
import { memoryDirs, sandboxed } from '../core/guards.ts'
import { protectConfig } from '../runtime/path-guards.ts'
import { stopLine } from '../core/board.ts'
import { modelFor, placeFor, sessionKey, type Conversation, type Lane } from '../core/conversations.ts'
import { mayStop, senderOf } from '../core/gate.ts'
import { foreignAgentTags } from '../core/agents.ts'
import { Dispatcher, mixRunners, startFailedNote } from '../core/sessions.ts'
import { readSettings, setKey, sweepImported } from '../runtime/config-files.ts'
import { configWatcher } from '../runtime/config-watch.ts'
import { DEFAULT_MODEL, unknownNames } from '../core/config.ts'
import type { Task } from '../core/task.ts'
import type { ToSession } from '../runtime/protocol.ts'
import { homeThread, postAsKage, sessionTools, threadPing } from '../runtime/kage-tools.ts'
import { scheduler } from '../runtime/scheduler.ts'
import { runJobs } from '../runtime/jobs.ts'
import { mcpStatus, needsWatch, sdkLook } from '../runtime/job-needs.ts'
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
import { readCommand } from '../runtime/kagelets/manager.ts'
import { kageletDeliver } from '../runtime/kagelets/notes.ts'
import { hubLock } from '../runtime/hub-lock.ts'
import { rotate } from '../runtime/hub-log.ts'
import { hubKagelets } from './kagelets.ts'
import { ownerCommands } from './owner-commands.ts'
import { startConnectors } from './connectors.ts'
import { hubUpdates } from './updates.ts'
import { ownerDigests } from './owner-digests.ts'
import { dreams } from './dreams.ts'
import { DREAM_KEY, DREAM_LIMITS, type DreamLesson } from '../core/dream.ts'
import { closedThreads } from '../runtime/closed-threads.ts'
import { checkScopes } from '../runtime/slack-scopes.ts'
import { scopeDm } from '../core/slack-scopes.ts'
import { startTelemetry } from './telemetry.ts'
import { ownerLines } from '../core/messages.ts'
import { answersInThread, blockedTask, planDrop } from '../core/blocks.ts'
import { unanswered } from '../core/ledgers.ts'

const { ENV_FILE, NAME, Title, TEAMMATES, TRUSTED_PEOPLE, TRUSTED_APPS, config, secrets, bot, user } = load()
const { harness = {}, kagelets: kl = {}, afk = {}, connectors: conn = {} } = config
const DIR = dirname(ENV_FILE)
const CODE = dirname(dirname(fileURLToPath(import.meta.url)))
if (await askSocket(`${DIR}/router.sock`, { type: 'board' }, 2000).then(() => true, () => false)) {
  log('another hub is running and answers on its socket, so this one exits')
  process.exit(0)
}
if (!await hubLock(`${DIR}/hub.lock`)) {
  log('another hub holds the hub lock, so this one exits')
  process.exit(0)
}
const THREADS = `${DIR}/threads.json`
const CLAUDE = process.env.KAGE_CLAUDE || (log('KAGE_CLAUDE is not set: start Kage with kage start'), process.exit(1))
if (process.platform === 'darwin') spawn('caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore' }).on('error', () => {}).unref()
const MAX = harness.maxSessions || 4
const IDLE_MIN = harness.idleMinutes || 30
process.on('unhandledRejection', e => log('unhandled', e))
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.on(sig, () => { log(`stopped by ${sig}`); process.exit(0) })
process.on('uncaughtException', e => { log('crashed', e); process.exit(1) })
const COMMANDS = new Map<string, string>(Object.entries(conn.commands ?? {}))

const store = openStore(`${DIR}/kage.db`)
const deferred = deferredApprovals(store)
const answerCard = (id: string, behavior: 'allow' | 'deny', always?: true) => answerDeferred(deferred, (key, task) => { if (toSession(key, task) === 'failed') failed(task) }, id, behavior, Date.now(), always && (c => kag.alwaysAllow(c.key, c.tool, c.input)))
const SSM_SOCK = `${DIR}/ssm.sock`, SSM_SHIM = `${CODE}/cli/ssm-plugin-shim`
const ssm = ssmRelay({ path: SSM_SOCK, plugin: findPlugin(undefined, [SSM_SHIM]), trusted: key => store.relayOk(key), log })
const KEYS_SOCK = `${DIR}/keys.sock`
const keys = keyProxy({ path: KEYS_SOCK, routes: config.sessionKeys ?? {}, trusted: key => store.relayOk(key), log })
store.importState({ afk: `${DIR}/afk.json`, 'github-threads': `${DIR}/github-threads.json`, 'mail-threads': `${DIR}/mail-threads.json` })
const ledgers = openLedgers(DIR, undefined, line => log(line), (name, cells) => { if (name === 'posted' && cells[3]) runs.posted(cells[3]) })
const runs = runEvents(ledgers, randomUUID)
const placeOf = (key: string) => placeFor(k => store.conversation(k)?.place, key)
const inbox: Inbox = { take: (source, connector, payload) => store.take(source, connector, payload, Date.now()), handled: source => limits.handled(source), has: source => store.has(source) }

const starters = new Map<string, string>()
const deliver = (c: Conversation, task: Task, place: string, lane: Lane = 'main', by?: string) => {
  const key = sessionKey(c, { lane })
  if (by && !d.saved()[key] && !starters.has(key)) starters.set(key, by)
  store.seen(key, c, place, Date.now())
  log(`task for ${place} (${logKey(key)}): ${task.fromOwner ? 'from the owner' : 'not from the owner'}${task.scheduled ? ', scheduled' : ''}, ${d.saved()[key] ? 'resumes its session' : 'new session'}`)
  return toSession(key, task)
}
function stopThread(key: string, cut: boolean): string {
  const now = Date.now()
  const end = (k: string) => {
    kag.incidents.stopped(k, now); const r = d.endThread(k, cut)
    const dropped = 'ok' in r ? r.dropped.filter((m): m is Task => m.type === 'task') : []
    if (dropped.length) limits.turn(k, dropped, undefined, now)
    return { r, dropped: dropped.length }
  }
  const lanes = Object.keys(d.saved()).filter(k => k.startsWith(`${key}#`)).map(end).filter(l => 'ok' in l.r)
  const { r, dropped } = end(key)
  const let_go = dropped + lanes.reduce((n, l) => n + l.dropped, 0)
  const laneEnding = lanes.some(l => 'ok' in l.r && l.r.ending)
  const main = 'ok' in r ? { ...r, ...(laneEnding && { ending: true as const }), dropped: let_go }
    : lanes.length ? { ok: true as const, ...(laneEnding && { ending: true as const }), dropped: let_go } : r
  return stopLine(main, schedules.list(key).map(s => s.prompt.slice(0, 60)), lanes.length)
}
const toSession = (key: string, task: Task) => {
  if (closedTo(key, task)) return 'sent'
  if (limits.hold(key, task, Date.now())) return 'held'
  noteTrust(key, task)
  const r = d.task(key, task, Date.now())
  if (r !== 'failed') {
    limits.delivered(key, task)
    if (sdk && !onPane.has(key)) runs.start(key, task.scheduled ? `scheduled ${task.job ?? ''}` : `task from the ${senderOf(task)}`, { fresh: !!task.scheduled, ...(task.handoff && { chain: task.handoff.chain, hops: task.handoff.hops }) })
  }
  return r
}
const sayInThread = (key: string, t: Task, text: string) => void postAsKage({ title: Title, bot, user }, t.meta.channel, t.meta.thread_ts || undefined, text).then(
  r => ledgers.add('posted', [t.meta.channel, r.ts, r.by, key]),
  e => log('could not post in the thread', logKey(key), e?.data?.error ?? e))
const { blocked, closedTo, isClosed } = closedThreads({
  store,
  reset: key => d.reset(key),
  say: sayInThread,
  tellOwner: text => void owner.say(text),
})
const dropToldOwner = new Set<string>()
function dropped(key: string, turn: Task[], reason: string, kind: string) {
  log('a hook dropped the prompt in', logKey(key), kind)
  runs.emit(key, 'refusal', `hook: ${kind}`)
  const p = planDrop(turn, reason), t = blockedTask(turn)
  if (p.reply && t) sayInThread(key, t, p.reply)
  if (p.dm && !dropToldOwner.has(key)) { dropToldOwner.add(key); void owner.say(p.dm) }
}
const noteTrust = (key: string, t: Task) =>
  t.need || store.noteTask(key, senderOf(t) === 'owner', key in d.saved())
function phoneOwner(reason: string): Promise<string> {
  const command = conn.call?.command
  if (!command) return Promise.resolve('no connectors.call.command')
  if (!voice) return Promise.resolve('voice is off (voiceToken)')
  const p = spawn(command, { shell: true, stdio: 'ignore', env: { ...process.env, KAGE_CALL_CODE: voice.issueCode(), KAGE_CALL_REASON: reason.slice(0, 300) } })
  const timer = setTimeout(() => p.kill(), 60_000)
  return new Promise(res => { p.on('error', e => res(String(e))); p.on('close', code => { clearTimeout(timer); res(code === 0 ? '' : `dialer exited ${code ?? 'on timeout'}`) }) })
}
const jev = jevConfig(config.jev, secrets.jevKey)
if (jev && 'error' in jev) log(`jev is off: ${jev.error}`)
else if (jev) log(`jev checks ${jev.agents === 'all' ? 'every listed agent' : jev.agents.join(', ')} at threshold ${jev.threshold}`)

const slack = await connectSlack({
  catchUpMax: () => config.tripwires?.catchUpMax || 1000, dir: DIR, appToken: secrets.slack!.app!, userToken: secrets.slack!.user!, bot, user, name: NAME, title: Title, askOtherAgents: config.askOtherAgents, teammates: TEAMMATES, trusted: TRUSTED_PEOPLE, apps: TRUSTED_APPS,
  hub: { deliver, stop: (c, cut, by) => {
      const key = sessionKey(c, { lane: 'main' })
      return mayStop(by, slack.ids.owner, starters, key) ? stopThread(key, cut) : 'Only the owner, or the teammate whose task started this thread, can stop it.'
    }, verdict: (id, behavior, always) => ownerVerdict(id, behavior, always), status: () => commands.status(), heard: m => schedules.heard(m), channelPost: p => jobs.channelPost(p), channelCatchUp: h => jobs.channelCatchUp(h), channelGap: () => jobs.channelGap(),
    posted: () => ledgers.text('posted'), kageletsIn: (chat, thread) => kag.peopleIn(chat, thread), kageletAsk: (chat, thread, name, from, text) => kag.ask(chat, thread, name, from, text), ownerWrote: (chat, thread, text) => { for (const k of kag.notes.wrote(kag.lanes(), chat, thread, text)) runs.emit(k, 'owner-note', `${text.length} characters`) }, ...inbox },
  jev: jev && !('error' in jev) ? jevCheck(jev) : undefined, ackWords: config.jev?.ackWords !== false,
  triage: jev && !('error' in jev) ? jevTriage(jev, (who, detail) => runs.emit(who, 'triage', detail)) : undefined,
  afk: afk.on === false ? undefined : { memory: memoryDirs(process.env.HOME!, ENV_FILE, harness).owner, model: afk.model || DEFAULT_MODEL, saved: store, call: phoneOwner, jev: jev && !('error' in jev) ? jevAfk(jev) : undefined },
})
const waOn = config.connectors?.whatsapp?.on !== false && !!secrets.waha?.WAHA_API_KEY
const waSay = waOn ? wahaToOwner(wahaUrl(config.connectors?.whatsapp?.wahaUrl), secrets.waha!.WAHA_API_KEY!, Title, NAME) : undefined
const owner = ownerChannel({ pick: () => config.owner?.channel, slack: slack.notifyOwner, ...waSay && { whatsapp: waSay } })
const waCardCodes = waCards()
function ownerVerdict(id: string, behavior: 'allow' | 'deny', always?: true): boolean {
  return d.verdict(id, { type: 'verdict', request_id: id, behavior }) || answerCard(id, behavior, always)
}
function cardToWhatsApp(c: { id: string; tool: string; description: string; place: string; preview: string }) {
  if (config.owner?.channel !== 'whatsapp' || !waSay) return
  const code = waCardCodes.open(c.id)
  const note = waCardNote({ ...c, code }, NAME)
  if (!note) { waCardCodes.take(code); return }
  void waSay(note).then(sent => { if (!sent) waCardCodes.take(code) })
}
function answerFromWhatsApp(a: { code: string; behavior: 'allow' | 'deny' }) {
  const id = waCardCodes.take(a.code)
  const done = !!id && ownerVerdict(id, a.behavior)
  log('whatsapp card answer', a.code, id ? (done ? a.behavior : 'already answered') : 'no such card')
  void waSay?.(!id ? `No card waits on ${a.code}.` : done ? (a.behavior === 'allow' ? 'Approved.' : 'Denied.') : 'That card was already answered.')
}

if (existsSync(THREADS)) {
  const r = store.importThreads(JSON.parse(readFileSync(THREADS, 'utf8')), slack.ids.botDm, Date.now())
  log(`moved threads.json into the store: ${r.imported} threads${r.skipped.length ? `, skipped ${r.skipped.join(' ')}` : ''}`)
  renameSync(THREADS, `${THREADS}.imported`)
}
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
const MEM = memoryDirs(process.env.HOME!, ENV_FILE, harness)
const PROJECT = claudeProject(process.cwd())
const recordCost = costRecorder(ledgers)
rmSync(`${DIR}/browser-seen`, { force: true })
let seenVersion: string | undefined
let browserSeen = 0
const browser = secrets.browserToken ? connectBrowser({ token: secrets.browserToken, port: conn.browser?.port || 8791,
  onPoll: (at, v) => { if (at - browserSeen >= 30_000 || v !== seenVersion) { browserSeen = at; seenVersion = v; writeFileSync(`${DIR}/browser-seen`, `${at} ${v ?? ''}`.trim(), { mode: 0o600 }) } } }) : undefined
void browser?.listening.then(port => log(`browser on: 127.0.0.1:${port}/browser`), e => log('browser could not listen', e))
const browserBlock = (conn.browser?.block ?? []).join(',')
const BROWSER_BLOCK = blockList(browserBlock), SCREEN = process.platform === 'darwin' ? screenRecorder({ folder: `${DIR}/screen`, code: CODE }) : undefined
for (const e of unreadableBlocks(browserBlock)) log(`connectors.browser.block: "${e}" is not a site, so it blocks nothing`)
const sdkLib = harness.runtime === 'tmux' ? undefined : await (async () => ({
  lib: await import('@anthropic-ai/claude-agent-sdk'),
  claude: execFileSync('/bin/sh', ['-c', 'command -v claude'], { encoding: 'utf8' }).trim(),
}))().catch((e: Error) => {
  console.error(`Agent SDK not usable (${e.message}), so threads open as tmux panes. Run npm ci, then restart.`)
  return undefined
})
const kag = hubKagelets({ dir: DIR, kl, mem: MEM, store, ledgers, runs, title: Title, notify: text => void owner.say(text), hasSdk: () => !!sdk,
  runNow: (id, now, lead) => schedules.runNow(id, now, lead), toSession: (key, task) => toSession(key, task), lanes: { busy: key => d.ready(key) === 'busy', last: key => runner.lastActivity(key), cut: key => void d.endThread(key, true) },
  idle: key => !isClosed(key) && d.ready(key) === 'ready' && d.startsNow(key, Date.now()), paused: now => limits.paused(now)?.until, tripwires: () => config.tripwires, openHome: homeThread({ title: Title, bot, user, ids: slack.ids }) })
const sessionOptions = (claude: string) => ({
  cwd: process.cwd(),
  settingSources: ['user', 'project', 'local'] as ('user' | 'project' | 'local')[],
  plugins: [{ type: 'local' as const, path: CODE }],
  settings: { autoMemoryDirectory: MEM.own, ...harness.pluginsOff?.length && { enabledPlugins: Object.fromEntries(harness.pluginsOff.map(p => [p, false])) } },
  pathToClaudeCodeExecutable: claude,
})
const needs = needsWatch({ store, placeOf, notify: t => owner.say(t), ...sdkLib && { look: sdkLook(sdkLib.lib.query as Parameters<typeof sdkLook>[0], sessionOptions(sdkLib.claude)) } })
const sdk = sdkLib ? sdkSessions({
  sdk: sdkLib.lib,
  deferred,
  hub: () => d,
  tools: (key, send, approve, turnSender) => sessionTools({
    title: Title, bot, user, botDm: () => slack.ids.botDm, dir: DIR, ledgers, send, memory: MEM, turnSender, cardOut: cardToWhatsApp,
    schedules: { add: j => jobs.add(key, j, Date.now()), remove: id => jobs.remove(key, id), list: () => schedules.list(key), hookUrl: id => jobs.hookUrl(id), tune: (id, t) => schedules.tune(key, id, t, Date.now()), restore: id => jobs.swaps.restore(key, id, Date.now()), move: (id, to) => schedules.move(key, id, to, Date.now()) },
    afk: slack.afk?.command,
    settings: { set: (key, value) => setKey(ENV_FILE, key, value) },
    kagelet: key.split('#side-kagelet-')[1], dreaming: key.split('#side-kdream-')[1], kageletMemory: kag.kmem, ...key === DREAM_KEY && { dreamLessons: (l: DreamLesson[]) => dreaming.lessons(l) },
    browser: browser && { call: browser.call, block: BROWSER_BLOCK },
    foreignAgents: () => config.askOtherAgents ? [] : foreignAgentTags(slack.ids.apps ?? [], slack.ids.owner),
    meetbot: meeting && { join: meeting.join }, screen: SCREEN,
    dbRead: { command: () => readCommand(kl.dbRead?.command ?? undefined, store, key.split('#side-kagelet-')[1] ?? ''), maxRows: kl.dbRead?.maxRows || 200 },
    kagelets: { list: () => kag.manager.list(Date.now()), manage: (a, ask) => kag.manager.manage(a, Date.now(), ask) }, approve,
    event: (kind, detail) => runs.emit(key, kind, detail),
    onReport: r => kag.routes.reported(key, r), message: (to, text) => kag.routes.message(key, to, text), toManager: needs => kag.needs.add(key, key.split('#side-kagelet-')[1] ?? '', needs, Date.now()), tellKagelet: (name, text, now) => kag.tell(name, text, now),
  }),
  hasTranscript: tmux.hasTranscript, trustedNow: person => (slack.ids.trusted ?? []).includes(person),
  toHub: (key, m) => routeReply(key, m, replies),
  options: sessionOptions(sdkLib.claude),
  onMcp: q => { if (needs.watching()) void mcpStatus(q).then(needs.seen).catch(e => log('mcp status failed', e)) },
  ownerMemory: MEM.owner, ownMemory: MEM.own, sharedTools: config.sharedTools,
  envFile: ENV_FILE,
  codeDir: CODE, sandbox: owner => sandboxed(config.harness?.sandbox, owner),
  ssm: { sock: SSM_SOCK, shim: SSM_SHIM, issue: key => ssm.issue(key), drop: key => ssm.drop(key) },
  keys: { sock: KEYS_SOCK, issue: key => keys.issue(key), drop: key => keys.drop(key) },
  onStart: () => store.saveSessions(d.saved()),
  onResult: (key, total, resumed, limited, error) => {
    const usd = recordCost(key, total, resumed)
    kag.routes.ended(key, usd ?? 0, d.saved()[key] ? `${PROJECT}/${d.saved()[key]}.jsonl` : '', Date.now(), limited, error)
  },
  budgetOf: kag.budgetOf,
  modelOf: key => modelFor(key, config.harness?.jobModel, k => k.includes('#side-kdream-') ? DEFAULT_MODEL : k.startsWith('voice:') && config.connectors?.voice?.model ? config.connectors.voice.model : kag.modelOf(k)),
  onBlocked: blocked, onDropped: dropped,
  onTurn: (key, tasks, limit, done) => limits.turn(key, tasks, limit, Date.now(), done),
  grantOf: kag.grantOf, allowOf: kag.allowOf, reviewHeld: kag.reviewHeld,
  onTool: (key, tool, refused) => runs.emit(key, refused ? 'refusal' : 'tool', refused ? `${tool}: ${refused}` : tool),
}) : undefined
if (sdk) mkdirSync(MEM.own, { recursive: true })
kag.sync(Date.now())

const saved = store.sessions()
const runningAtStart = tmux.running()
for (const [k, id] of Object.entries(saved)) if (!tmux.hasTranscript(id) && !runningAtStart.has(id)) { delete saved[k]; store.forget(k) }

const onPane = new Set(Object.keys(saved).filter(k => runningAtStart.has(saved[k]!)))
const runner = !sdk ? tmux.runner : onPane.size ? mixRunners(tmux.runner, sdk.runner, onPane) : sdk.runner
const d: Dispatcher<ToSession> = new Dispatcher<ToSession>(runner, {
  max: MAX, idleMs: IDLE_MIN * 60_000, connectMs: (CLAUDE.includes('development-channels') ? 30 : 3) * 60_000,
  evictMs: 2 * 60_000, newId: randomUUID, saved,
})
const limits = limitPause({
  store, log, event: detail => ledgers.event({ kind: 'limit', who: 'hub', trace: '', detail }), settle: (tasks, done) => { kag.routes.settle(tasks, done); kag.needs.settle(tasks, done); if (done) for (const t of unanswered(tasks, ledgers.text('posted'))) if (answersInThread(t)) slack.seen(t) },
  tellOwner: text => void owner.say(text),
  end: key => d.end(key).filter(m => m.type === 'task'),
  defers: key => !!sdk && !onPane.has(key),
  notice: (t, text) => void postAsKage({ title: Title, bot, user }, t.meta.channel, t.meta.thread_ts || undefined, text).then(
    r => ledgers.add('posted', [t.meta.channel, r.ts, r.by, `${t.meta.channel}:${t.meta.thread_ts}`]),
    e => log('could not post the pause notice', t.meta.place, e?.data?.error ?? e)),
  replay: r => replayOf(r.connector)?.(r.source, r.payload) ?? Promise.reject(new Error(`no ${r.connector} connector to replay through`)),
  redeliver: (key, task) => { if (toSession(key, task) === 'failed') failed(task) },
})
limits.restore()
d.adopt(Object.keys(saved).filter(k => runningAtStart.has(saved[k]!)), Date.now())
restoreHolds(DIR, d)
const pingThread = threadPing({ title: Title, bot, user, thread: key => store.conversation(key)?.conversation, posted: cells => ledgers.add('posted', cells) })
const schedules = scheduler({ store, failed,
  soon: (fn, ms) => { setTimeout(() => { const now = Date.now(); if (!limits.draining(now)) fn(now) }, ms).unref() },
  deliver: kageletDeliver(kag.notes, toSession, kag.board),
  ready: key => d.ready(key),
  trusted: key => store.trust(key) === true, job: { end: k => d.reset(k), project: PROJECT, carryChars: () => config.harness?.jobCarryChars ?? 500, laneDefault: () => config.harness?.jobLaneDefault ?? true, freshEvery: () => config.harness?.jobFreshEvery ?? 20, carryCount: () => config.harness?.jobCarry ?? 5, posted: () => ledgers.text('posted'), catchUp: () => ({ hours: config.harness?.jobCatchUpHours ?? 12, staggerSeconds: config.harness?.jobCatchUpStaggerSeconds ?? 15 }) },
  ran: j => ledgers.add('runs', [j.id, j.key]),
  tripwires: () => config.tripwires ?? {}, event: e => ledgers.event(e), owner: t => void owner.say(t), ping: (s, text) => pingThread(s.key, text, s.id),
})
const CRONS = `${DIR}/crons-import.json`
if (existsSync(CRONS) && runningAtStart.size) log('crons-import.json waits: panes are still running, so their jobs are still alive')
else if (existsSync(CRONS)) {
  try {
    const f = JSON.parse(readFileSync(CRONS, 'utf8'))
    const r = schedules.adopt(f.jobs, f.ranUntil)
    log(`adopted ${r.adopted.length} cron jobs from the panes${r.skipped.length ? `, skipped ${r.skipped.join(' ')}` : ''}`)
    renameSync(CRONS, `${CRONS}.imported`)
  } catch (e) {
    log('crons-import.json is unreadable, moved to .bad', e)
    renameSync(CRONS, `${CRONS}.bad`)
    void owner.say(ownerLines.cronImportBad())
  }
}

const { meeting, voice, replies, replayOf, jobs, clock } = startConnectors({ secrets, conn, store, slack, bot, ping: pingThread, say: owner.say, ownerAnswer: answerFromWhatsApp, NAME, CODE, DIR, d, inbox, deliver, placeOf, failed, schedules, event: ledgers.event, ledgers, tripwires: config.tripwires })
listenForCommands(slack.socket, { user, team: slack.ids.team!, commands: COMMANDS, ledgers })

function failed(m: ToSession) {
  if (m.type !== 'task') return
  limits.turn('', [m], undefined, Date.now())
  log('could not deliver to a session:', m.meta.place, m.origin.ts, `(attach: tmux attach -t ${NAME})`)
  if (!m.origin.ts) void owner.say(startFailedNote(m.meta.place, d.lastStartError(), true))
  else if (!answersInThread(m)) void owner.say(startFailedNote(m.meta.place, d.lastStartError()))
  else slack.failed(m)
}

const digests = ownerDigests({ dir: DIR, ledgers, store, placeOf, costTracked: !!sdk, expireHours: () => config.waiting?.expireHours ?? 72, notify: t => owner.say(t) })
const dreaming = dreams({ dir: DIR, code: CODE, title: Title, botDm: slack.ids.botDm, mem: MEM, project: PROJECT, kagelets: kag.dir, kmem: kag.kmem, hasSdk: !!sdk, limits: () => ({ ...DREAM_LIMITS, ...config.dream }),
  store, ledgers, placeOf, paused: () => !!limits.paused(), quiet: now => d.quietEverywhere(now), deliver, toSession })
const updates = hubUpdates({ code: CODE, dir: DIR, ledgers, quiet: now => d.quietEverywhere(now) && !limits.paused(now), notify: t => owner.say(t) })
const VERSION = updates.VERSION

runJobs([
  { name: 'schedules', every: 20_000, run: now => { if (!limits.draining(now)) schedules.tick(now); jobs.swaps.tick(now) } },
  { name: 'sweep', every: 60_000, run: now => d.sweep(now).forEach(failed) },
  { name: 'limit pause', every: 20_000, run: now => limits.tick(now) },
  { name: 'daily note', every: 10 * 60_000, run: digests.dailyNote },
  { name: 'self-update', every: 60_000, run: updates.selfUpdate },
  ...config.autoUpdate === false ? [] : [{ name: 'auto-update', every: 6 * 3_600_000, run: updates.autoUpdate }],
  { name: 'auto-release', every: 3_600_000, run: updates.autoRelease },
  { name: 'hub-log', every: 3_600_000, run: () => rotate(`${DIR}/hub.log`) },
  { name: 'kagelets', every: 60_000, run: kag.sync },
  { name: 'dream', every: 10 * 60_000, run: dreaming.dream },
  { name: 'kagelet dreams', every: 10 * 60_000, run: dreaming.kageletDreams },
  { name: 'retro', every: 10 * 60_000, run: digests.weeklyRetro }, ...clock, ...needs.jobs,
  { name: 'kagelet messages', every: 20_000, run: now => { kag.routes.pump(now); kag.needs.pump(now); kag.measure(now) } },
  { name: 'events', every: 3_600_000, run: now => ledgers.pruneEvents(new Date(now - EVENT_DAYS * 86_400_000).toISOString()) }, ...startTelemetry({ config: config.telemetry, dir: DIR, code: CODE, ledgers, state: store, notify: t => owner.say(t), usage: sdk?.usage, shape: () => { const s = store.schedules(); return { email: +!!conn.email?.on, voice: +!!conn.voice?.on, whatsapp: +!!conn.whatsapp?.on, github: +!!conn.github, meeting: +!!conn.meeting, browser: +!!conn.browser, schedules: s.length, tripwires: s.filter(j => j.trigger).length, kagelets: [...kag.lanes()].length, teammates: TEAMMATES.length } } }),
])

const commands = ownerCommands({ d, store, ledgers, limits, MAX, placeOf, closedTo, noteTrust, failed, dropRelay: key => { ssm.drop(key); keys.drop(key) }, botDm: slack.ids.botDm, post: slack.say })
const watcher = configWatcher({
  envFile: ENV_FILE, boot: { config, secrets }, log, apply: slack.allow, tell: text => void owner.say(text),
  event: (kind, keys) => ledgers.event({ kind, who: 'config', trace: '', detail: keys.join(', ') }),
  restartWanted: yes => updates.restartWanted(yes),
})
const reload = watcher.check
listenForSessions(`${DIR}/router.sock`, d, { ...replies, failed, schedules: jobs, tell: commands.tell, say: commands.say, relay: commands.relay, reload, paused: () => limits.paused(), limitCounts: () => limits.counts,
  end: (key, cut) => stopThread(key, cut), kagelet: (action, name) => kag.manager.manage({ action, name }, Date.now()),
  quiesce: () => { const now = Date.now(); limits.drain(now); return d.unquiet(now).filter(u => u.why !== 'just active' && u.why !== 'open in a terminal') }, callCode: voice?.issueCode })

await slack.start()
try { for (const f of sweepImported(ENV_FILE)) log(`deleted ${f}, 7 days after the import`) } catch (e) { log(`could not sweep old env files: ${e}`) }
const updated = updatedNote(DIR, CODE, VERSION)
if (updated) { log(updated); void owner.say(updated).then(sent => { if (sent) clearUpdatedFrom(DIR) }) }
const unplaced = unknownNames(readSettings(ENV_FILE).config).join(', ')
const told = `${DIR}/config-unknown-told`
if (unplaced && (existsSync(told) ? readFileSync(told, 'utf8') : '') !== unplaced) {
  void owner.say(ownerLines.settingsUnplaced(unplaced))
    .then(sent => { if (sent) writeFileSync(told, unplaced) })
}
const SCOPES_TOLD = 'slack-scopes-told'
void checkScopes({ user: secrets.slack?.user, bot: secrets.slack?.bot }).then(m => {
  const { send, told } = scopeDm(m, store.load(SCOPES_TOLD) as string | undefined)
  if (send) void owner.say(send).then(sent => { if (sent) store.save(SCOPES_TOLD, told) })
  else store.save(SCOPES_TOLD, told)
}).catch(e => log(`scope check failed: ${e}`))
store.prune(Date.now() - 7 * 86_400_000)
kag.routes.replay(Date.now()); kag.needs.replay(Date.now())
const missed = store.unhandled(Date.now() - 10 * 60_000)
if (missed.length) log(`replaying ${missed.length} message${missed.length === 1 ? '' : 's'} the last run heard but never handled`)
for (const r of missed) {
  const replay = replayOf(r.connector)
  if (replay) void replay(r.source, r.payload).catch(e => log('replay failed', r.source, e))
  else { log('cannot replay', r.source, '(its connector is off)'); store.handled(r.source) }
}
log(`listening as ${slack.botUser} (@${NAME}) for ${slack.ownerName} ${slack.ids.owner}; up to ${MAX} sessions; teammates ${TEAMMATES.join(',') || 'none'}`)
