#!/usr/bin/env node
// Kage hub: wires the pieces together and holds no rules of its own.
//   connectors/  Slack and email: hear a message, pass the gate, hand the hub a Task
//   core/        pure rules: the gate, the dispatcher, what may go out, ledgers, hook guards
//   runtime/     where sessions run (tmux panes), the socket they connect to, the store
// server.ts is the other end: the Kage channel inside each thread's Claude Code session.
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { load, log } from './config.ts'
import { connectEmail } from './connectors/email.ts'
import { connectSlack } from './connectors/slack.ts'
import { sessionKey, type Conversation, type Lane } from './core/conversations.ts'
import { dailyDue, openWaiting, staleWaiting } from './core/ledgers.ts'
import { Dispatcher } from './core/sessions.ts'
import type { Task, ToSession } from './runtime/protocol.ts'
import { listenForSessions } from './runtime/session-link.ts'
import { openStore } from './runtime/store.ts'
import { tmuxWindows } from './runtime/tmux-windows.ts'

const { ENV_FILE, NAME, Title, TEAMMATES, env, need, bot, user } = load()
const DIR = dirname(ENV_FILE)
const THREADS = `${DIR}/threads.json`
// start.sh sets the command that starts Claude Code with the kage channel.
const CLAUDE = process.env.KAGE_CLAUDE || (log('KAGE_CLAUDE is not set: start Kage with ./start.sh'), process.exit(1))
const MAX = Number(env.KAGE_MAX_SESSIONS || 4)
const IDLE_MIN = Number(env.KAGE_IDLE_MINUTES || 30)
process.on('unhandledRejection', e => log('unhandled', e))

// One SQLite file holds every conversation seen and the session working on each (runtime/store.ts).
const store = openStore(`${DIR}/kage.db`)
const placeOf = (key: string) => store.conversation(key)?.place ?? key

// Connectors hand the hub a conversation; the hub alone turns it into a session key.
const deliver = (c: Conversation, task: Task, place: string, lane: Lane = 'main') => {
  const key = sessionKey(c, { lane })
  store.seen(key, c, place, Date.now())
  return d.task(key, task, Date.now())
}
const slack = await connectSlack({
  appToken: need('SLACK_APP_TOKEN'), bot, user, name: NAME, title: Title, teammates: TEAMMATES,
  hub: { deliver, verdict: (id, behavior) => d.verdict(id, { type: 'verdict', request_id: id, behavior }), status },
})

// threads.json came before the store: move it in once (the "dm" key needs the bot DM's id), then retire it.
if (existsSync(THREADS)) {
  const r = store.importThreads(JSON.parse(readFileSync(THREADS, 'utf8')), slack.ids.botDm, Date.now())
  log(`moved threads.json into the store: ${r.imported} threads${r.skipped.length ? `, skipped ${r.skipped.join(' ')}` : ''}`)
  renameSync(THREADS, `${THREADS}.imported`)
}

const tmux = tmuxWindows({
  name: NAME, envFile: ENV_FILE, claude: CLAUDE,
  idOf: key => d.saved()[key],
  placeOf,
  onStart: () => store.saveSessions(d.saved()),
})
// A thread whose transcript is gone has nothing to resume, so it leaves the store. A pane that just
// started has no transcript yet, so running panes are kept.
const saved = store.sessions()
const runningAtStart = tmux.running()
for (const [k, id] of Object.entries(saved)) if (!tmux.hasTranscript(id) && !runningAtStart.has(id)) { delete saved[k]; store.forget(k) }

// The dev route waits for a person to confirm a warning screen in each new pane. A full house hands
// the slot of a session quiet for 2 min to a new thread.
const d = new Dispatcher<ToSession>(tmux.windows, {
  max: MAX, idleMs: IDLE_MIN * 60_000, connectMs: (CLAUDE.includes('development-channels') ? 30 : 3) * 60_000,
  evictMs: 2 * 60_000, newId: randomUUID, saved,
})
// Panes still running from before this hub restarted keep working.
d.adopt(Object.keys(saved).filter(k => runningAtStart.has(saved[k]!)), Date.now())

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
    `${open} question${open === 1 ? '' : 's'} waiting on you`,
  ].join('\n')
}

// Once a day from 10:30 IST, the owner gets the questions that have waited on them for a day or more.
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
// Each connector marks its own failures: ⚠️ on a Slack message, a DM line for an email.
const failed = (m: ToSession) => {
  if (m.type !== 'task') return
  log('could not deliver to a session:', m.meta.place, m.origin.ts, `(attach: tmux attach -t ${NAME})`)
  if (m.origin.channel === 'email') void slack.notifyOwner(`Could not start a session for ${m.meta.place}.`)
  else slack.failed(m)
}
setInterval(() => { try { d.sweep(Date.now()).forEach(failed) } catch (e) { log('sweep failed', e) } }, 60_000)

listenForSessions(`${DIR}/router.sock`, d, {
  mail: (key, text) => void email?.send(key, text).catch(e => {
    log('mail reply failed', key, e)
    void slack.notifyOwner(`Email reply failed for ${placeOf(key)}: ${e}`)
  }),
})

await slack.start()
log(`listening as ${slack.botUser} (@${NAME}) for ${slack.ownerName} ${slack.ids.owner}; up to ${MAX} sessions; teammates ${TEAMMATES.join(',') || 'none'}`)
// `setup.sh doctor` reads this to prove the hub reached Slack.
writeFileSync(`${DIR}/status`, `connected ${new Date().toISOString()} pid ${process.pid} as @${NAME}\n`, { mode: 0o600 })
