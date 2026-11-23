import { SocketModeClient, LogLevel } from '@slack/socket-mode'
import type { WebClient } from '@slack/web-api'
import { log, logger } from '../../runtime/log.ts'
import { loopGuard } from '../../core/agents.ts'
import { classify, DROPS, taskFrom, type Ids, quoteMessage } from '../../core/gate.ts'
import { agentTag, filesTag, postText, typedByPerson, type SlackMessage } from '../../core/slack-message.ts'
import type { SlackFile } from '../../core/slack-files.ts'
import { saveFiles } from '../../runtime/slack-files.ts'
import { filesFolderName, parseSessionKey, sessionKey, slackConversation, type Conversation, type Lane } from '../../core/conversations.ts'
import { askedFrom, cardAt, postedBy } from '../../core/ledgers.ts'
import type { Delivery } from '../../core/sessions.ts'
import type { Task } from '../../core/task.ts'
import { startAfk } from './afk.ts'
import { sayAsOwner } from './say.ts'
import { keepSocketUp } from './socket.ts'
import type { JevAfk, JevCheck, Triage } from '../jev.ts'
import { heardLine, writeHeard } from './heard.ts'
import { emptyRoom } from '../../runtime/claude-once.ts'
import type { Inbox, Saved } from '../../runtime/store.ts'
import { channelHistory, type ChannelHistory, type ChannelPost } from '../../runtime/channel-watch.ts'
import { ownerLines } from '../../core/messages.ts'
import { seenUpTo, type SessionNow, type ThreadMark } from '../../core/thread-delta.ts'
import { slackDirectory, type Directory } from './directory.ts'
import { agentOf, taskText } from './task-text.ts'

const PICKED_UP = 'ninja'
const SEEN = '+1'
const WAITING = 'hourglass_flowing_sand'
const FAILED = 'warning'
const POST_SUBTYPES = new Set([undefined, 'bot_message', 'thread_broadcast', 'file_share'])

export type Hub = {
  deliver(c: Conversation, task: Task, place: string, lane?: Lane, by?: string): Delivery
  stop(c: Conversation, cut: boolean, by: string): string
  verdict(requestId: string, behavior: 'allow' | 'deny', always?: true): boolean
  status(): string
  heard(m: { chat: string; thread?: string; quoted: string }): void
  ownerWrote?(chat: string, thread: string, text: string): void
  kageletsIn?(chat: string, thread: string): { name: string; people: string[] }[]; kageletAsk?(chat: string, thread: string, name: string, from: string, text: string): string
  channelPost?(post: ChannelPost): void
  channelCatchUp?(history: ChannelHistory): void
  channelGap?(): void
  posted(): string
  sessionOf?(c: Conversation, lane: Lane): SessionNow | undefined
} & Inbox

type Options = {
  askOtherAgents?: boolean; saved?: Saved; dir: string; appToken: string; userToken: string; bot: WebClient; user: WebClient
  name: string; title: string; teammates: string[]; trusted?: string[]; apps: string[]; hub: Hub; catchUpMax?: () => number
  afk?: { memory: string; model: string; saved: Saved; call?: (reason: string) => Promise<string>; jev?: JevAfk }
  jev?: JevCheck
  ackWords?: boolean
  heard?: (post: string) => Promise<string>
  triage?: Triage
}

type Slack = {
  o: Options; ids: Ids; bot: WebClient; user: WebClient; dir: Directory; ownerName: string
  react(channel: string, ts: string, name: string): Promise<boolean>
  unreact(channel: string, ts: string, name: string): void
  notifyOwner(text: string): Promise<boolean>
  kagePosted(ts: string): boolean
  replaying: Set<string>
  loops: ReturnType<typeof loopGuard>
  afk?: ReturnType<typeof startAfk>
}

type Trigger = ReturnType<typeof classify>
type TaskTrigger = Extract<Trigger, { kind: 'task' }>
type Control = Exclude<Trigger, { kind: 'task' | 'drop' | 'kagelet-ask' }>

export const ownerNote = (m: SlackMessage, ids: { owner: string; botDm: string }, reason: string) =>
  reason === 'not-tagged' && typedByPerson(m) && m.user === ids.owner && m.channel !== ids.botDm && !!m.thread_ts && m.thread_ts !== m.ts

export async function intake(m: SlackMessage, ack: () => Promise<void>, hub: Pick<Hub, 'take'>, hear: (m: SlackMessage, source: string) => Promise<void>) {
  delete m.fromSocket
  const source = m.channel && m.ts ? `slack:${m.channel}:${m.ts}` : undefined
  const fresh = !source || hub.take(source, 'slack', JSON.stringify(m))
  await ack()
  if (fresh) await hear(m, source ?? '')
}

export async function connectSlack(o: Options) {
  const { bot, user } = o
  const { ids, botUser } = await slackIds(o)
  const dir = slackDirectory(user, ids, o.title)
  const ownerName = (await dir.nameOf(ids.owner)).split(' ')[0] || 'the owner'
  const k: Slack = {
    o, ids, bot, user, dir, ownerName, replaying: new Set(), loops: loopGuard({ perWindow: 20, windowMs: 60_000, hops: 4 }),
    react: (channel, ts, name) => (channel === ids.botDm ? bot : user).reactions.add({ channel, timestamp: ts, name }).then(() => true, () => false),
    unreact: (channel, ts, name) => void (channel === ids.botDm ? bot : user).reactions.remove({ channel, timestamp: ts, name }).catch(() => {}),
    notifyOwner: text => bot.chat.postMessage({ channel: ids.botDm, text }).then(() => true, e => (log('owner DM failed', e?.data?.error ?? e), false)),
    kagePosted: ts => { const tsv = o.hub.posted(); return postedBy(tsv, ids.botDm, ts) !== undefined || cardAt(tsv, ids.botDm, ts) !== undefined },
  }
  k.afk = o.afk && startAfk({ dir: o.dir, title: o.title, ownerName, ids, bot, user, ...o.afk, notify: k.notifyOwner, contextOf: async m => (await dir.contextOf(m)).text, placeOf: dir.placeOf, nameOf: dir.nameOf })
  const failed = (task: Task) => k.react(task.origin.channel, task.origin.ts, FAILED)
  const seen = (task: Task) => { k.unreact(task.origin.channel, task.origin.ts, PICKED_UP); void k.react(task.origin.channel, task.origin.ts, SEEN) }
  const { socket, hear } = slackSocket(k, failed)
  const replay = async (source: string, payload: string) => {
    const m = JSON.parse(payload) as SlackMessage
    k.replaying.add(m.ts)
    try { await hear(m, source) } finally { k.replaying.delete(m.ts) }
  }
  const allow = (l: { teammates: string[]; trusted: string[]; apps: string[] }) => { ids.teammates = l.teammates; ids.trusted = l.trusted; ids.apps = l.apps }
  const { placeOf, nameOf, knownNames } = dir
  return { ids, ownerName, botUser, socket, failed, seen, notifyOwner: k.notifyOwner, placeOf, nameOf, knownNames, afk: k.afk, replay, allow, say: sayAsOwner({ user, ids, hub: o.hub, hear }), start: () => socket.start() }
}

async function slackIds(o: Options) {
  const me = await o.user.auth.test()
  const botAuth = await o.bot.auth.test()
  if (me.team_id !== botAuth.team_id) {
    log(`user token is for workspace ${me.team_id}, bot token for ${botAuth.team_id}; refusing to start`)
    process.exit(1)
  }
  const dm = await o.bot.conversations.open({ users: me.user_id! })
  const ids: Ids = { owner: me.user_id!, bot: botAuth.user_id!, botDm: dm.channel!.id!, name: o.name, teammates: o.teammates, trusted: o.trusted ?? [], apps: o.apps, team: me.team_id! }
  return { ids, botUser: botAuth.user }
}

function slackSocket(k: Slack, failed: (task: Task) => Promise<boolean>) {
  const { o, ids } = k
  const queue = new Map<string, Promise<void>>()
  const socket = new SocketModeClient({ appToken: o.appToken, logger, logLevel: LogLevel.WARN })
  socket.on('app_mention', async ({ ack }) => { await ack() })
  async function hear(m: SlackMessage, source: string) {
    const key = m.channel ? sessionKey(slackConversation(m, ids.botDm, k.kagePosted)) : ''
    const next = (queue.get(key) ?? Promise.resolve()).then(() => onMessage(k, m, failed)).catch(e => log('message handling failed', e))
    queue.set(key, next)
    await next
    if (source) o.hub.handled(source)
    if (queue.get(key) === next) queue.delete(key)
  }
  socket.on('message', ({ event, ack }) => intake(event as SlackMessage, ack, o.hub, hear))
  keepSocketUp(socket, { dir: o.dir, name: o.name, gap: () => o.hub.channelGap?.(), notifyOwner: k.notifyOwner })
  socket.on('connected', () => o.hub.channelCatchUp?.(channelHistory(a => o.user.conversations.history(a), o.catchUpMax?.() ?? 1000,
    (m, channel) => { const x = { ...(m as object), channel } as SlackMessage; return isChannelPost(k, x) ? [postOf(k, x)] : [] })))
  return { socket, hear }
}

const quoted = (k: Slack, m: SlackMessage, text?: string) =>
  quoteMessage({ user: m.user, ts: m.ts, text, client_msg_id: m.client_msg_id, blocks: (m as { blocks?: { block_id?: string }[] }).blocks }, k.ids.owner, { bot: k.ids.bot, title: k.o.title })

const postOf = (k: Slack, m: SlackMessage): ChannelPost => ({
  channel: m.channel, ts: m.ts, ...(m.user && { user: m.user }), ...(m.app_id && { app_id: m.app_id }), ...((m.bot_id || m.app_id) && { bot: true }), text: postText(m),
  quoted: quoted(k, m, postText(m) + filesTag(m)),
})

const isChannelPost = ({ ids }: Slack, m: SlackMessage) => !!m.channel && !m.channel.startsWith('D') && m.channel_type !== 'im' && m.channel_type !== 'mpim' && m.user !== ids.bot && POST_SUBTYPES.has(m.subtype)
  && !agentTag(ids.bot, ids.name).test(m.text ?? '')

function cardOf({ o, ids }: Slack, m: SlackMessage): string | undefined {
  if (m.channel !== ids.botDm || m.user !== ids.owner || !m.thread_ts || m.thread_ts === m.ts) return undefined
  return cardAt(o.hub.posted(), m.channel, m.thread_ts)
}

const postHeard = (k: Slack, m: SlackMessage, said: string) =>
  void heardLine(said, k.o.heard ?? writeHeard(emptyRoom(k.o.dir))).then(text => k.bot.chat.postMessage({ channel: m.channel, thread_ts: m.thread_ts ?? m.ts, text })).catch(e => log('could not post the heard line', e?.data?.error ?? e))

async function onMessage(k: Slack, m: SlackMessage, failed: (task: Task) => Promise<boolean>) {
  const { o, ids } = k
  if (isChannelPost(k, m)) try { o.hub.channelPost?.(postOf(k, m)) } catch (e) { log('channel post hook failed', e) }
  k.afk?.heard(m)
  const thread = `${m.channel}:${m.thread_ts ?? m.ts}`
  const t = classify(m, ids, cardOf(k, m), m.thread_ts ? o.hub.kageletsIn?.(m.channel, m.thread_ts) ?? [] : [])
  if (t.kind === 'kagelet-ask') { const said = o.hub.kageletAsk?.(m.channel, m.thread_ts!, t.name, m.user!, t.text); if (said) await k.bot.chat.postMessage({ channel: m.channel, thread_ts: m.thread_ts!, text: said }).catch(() => {}); return }
  if (t.kind === 'drop') return dropped(k, m, t.reason)
  if (typedByPerson(m)) k.loops.person(thread)
  if (t.kind !== 'task') return control(k, m, t)
  if (await agentSkipped(k, m, t, thread)) return
  const { pickedUp, answered } = await triaged(k, m, t, thread)
  if (answered) return
  const task = await deliverTask(k, m, t, pickedUp)
  if (task) failed(task)
}

function dropped(k: Slack, m: SlackMessage, reason: keyof typeof DROPS) {
  const { o, ids } = k
  if (reason !== 'not-tagged') log(`dropped ${m.channel}:${m.thread_ts ?? m.ts} from ${m.user ?? 'no user'}${m.app_id ? ` (app ${m.app_id})` : ''}: ${reason}, ${DROPS[reason]}`)
  if (typedByPerson(m) && m.channel !== ids.botDm && m.user !== ids.owner) {
    o.hub.heard({ chat: m.channel, ...(m.thread_ts && { thread: m.thread_ts }), quoted: quoted(k, m, m.text) })
  }
  if (ownerNote(m, ids, reason)) o.hub.ownerWrote?.(m.channel, m.thread_ts!, m.text ?? '')
}

function control(k: Slack, m: SlackMessage, t: Control) {
  const { o, bot } = k
  const underCard = (text: string) => bot.chat.postMessage({ channel: m.channel, thread_ts: m.thread_ts ?? m.ts, text }).catch(() => {})
  if (t.kind === 'verdict') {
    if (o.hub.verdict(t.request_id, t.behavior, t.always)) return void k.react(m.channel, m.ts, t.behavior === 'allow' ? 'white_check_mark' : 'x')
    log('no running session asked for', t.request_id)
    return void underCard(`Request \`${t.request_id}\` is no longer waiting (its session ended or it was already answered). Tag the original thread again to redo it.`)
  }
  if (t.kind === 'card') return void underCard(`Reply \`yes\` or \`no\` here to answer this request.`)
  if (t.kind === 'status') {
    k.react(m.channel, m.ts, PICKED_UP)
    return void k.notifyOwner(o.hub.status())
  }
  k.react(m.channel, m.ts, PICKED_UP)
  const text = o.hub.stop(slackConversation(m, k.ids.botDm, k.kagePosted), t.now, m.user!)
  return void bot.chat.postMessage({ channel: m.channel, thread_ts: m.thread_ts ?? m.ts, text }).catch(e => log('could not answer a stop', e?.data?.error ?? e))
}

async function agentSkipped(k: Slack, m: SlackMessage, t: TaskTrigger, thread: string): Promise<boolean> {
  const { o } = k
  if (!t.agent) return false
  const loop = k.loops.turn(t.agent, thread, Date.now())
  if (loop) {
    log(`dropped ${thread} from ${m.user ?? 'no user'} (app ${t.agent}): loop, ${DROPS.loop}: ${loop}`)
    if (k.loops.tell(t.agent, Date.now())) void k.notifyOwner(ownerLines.agentLoopStopped(t.agent, await k.dir.placeOf(m.channel), loop))
    return true
  }
  if (!o.jev) return false
  const j = await o.jev(t.agent, t.text)
  log(`${j.reply ? 'answering' : 'dropped'} ${thread} from app ${t.agent}: ${j.why}`)
  if (j.reply) return false
  if (o.ackWords === false) void k.react(m.channel, m.ts, 'white_check_mark')
  else postHeard(k, m, t.text)
  return true
}

async function triaged(k: Slack, m: SlackMessage, t: TaskTrigger, thread: string): Promise<{ pickedUp?: Promise<boolean>; answered?: true }> {
  const { o, ids } = k
  if (t.agent || !o.triage) return {}
  const pickedUp = k.react(m.channel, m.ts, PICKED_UP)
  const j = await o.triage(thread, !m.user || m.user === ids.owner ? 'owner' : 'other', t.text,
    { hasFiles: !!(m.files?.length || (m as { attachments?: unknown[] }).attachments?.length), inThread: !!m.thread_ts && m.thread_ts !== m.ts,
      context: async () => (await k.dir.contextOf(m, true)).text })
  if (j.pick !== 'react' || !await k.react(m.channel, m.ts, j.reaction?.emoji ?? 'eyes')) return { pickedUp }
  void pickedUp.then(() => k.unreact(m.channel, m.ts, PICKED_UP))
  if (o.ackWords !== false) postHeard(k, m, t.text)
  return { pickedUp, answered: true }
}

async function deliverTask(k: Slack, m: SlackMessage, t: TaskTrigger, pickedUp?: Promise<boolean>): Promise<Task | undefined> {
  const { o, ids, dir } = k
  const agent = agentOf(ids, m, t.agent)
  if (!pickedUp) k.react(m.channel, m.ts, PICKED_UP)
  const askedKey = m.channel === ids.botDm && m.thread_ts && m.thread_ts !== m.ts
    ? askedFrom(o.hub.posted(), ids.botDm, m.thread_ts) : undefined
  const asked = askedKey ? parseSessionKey(askedKey, ids.botDm)?.conversation : undefined
  const conv = slackConversation(m, ids.botDm, k.kagePosted)
  const markKey = !asked && !t.side && conv.thread ? sessionKey(conv) : undefined
  const session = markKey ? o.hub.sessionOf?.(conv, 'main') : undefined
  const since = markKey ? seenUpTo(((o.saved?.load('threadMarks') ?? {}) as Record<string, ThreadMark>)[markKey], session) : undefined
  const [place, ctx, link] = await Promise.all([
    dir.placeOf(asked?.chat ?? m.channel),
    m.channel === ids.botDm && !m.thread_ts ? Promise.resolve({ text: '', files: [] as SlackFile[] }) : dir.contextOf(m, false, since),
    k.user.chat.getPermalink({ channel: m.channel, message_ts: m.ts }).then(r => r.permalink ?? '').catch(() => ''),
  ])
  const meta = asked
    ? { channel: asked.chat, thread_ts: asked.thread!, place, permalink: link }
    : { channel: m.channel, thread_ts: m.thread_ts ?? m.ts, place, permalink: link }
  const saved = await saveFiles([...((m as { files?: SlackFile[] }).files ?? []), ...ctx.files],
    { folder: `${o.dir}/files/${filesFolderName(meta.channel, meta.thread_ts)}`, token: o.userToken })
  const person = agent ? agent.person : m.user !== ids.owner ? m.user : undefined
  const trusted = !!person && (ids.trusted ?? []).includes(person)
  const content = await taskText({ ids, dir, ownerName: k.ownerName, askOtherAgents: k.o.askOtherAgents }, m, t.text, { agent, person, trusted, asked: !!asked, saved, context: ctx.text, since })
  const task = taskFrom(m.user, ids.owner, {
    content,
    meta,
    origin: { channel: m.channel, ts: m.ts, ...(m.thread_ts && m.thread_ts !== m.ts && { thread: m.thread_ts }) },
    ...(agent && { agent: { app: agent.app, ...(agent.tag && { tag: agent.tag }), ...(agent.person && { person: agent.person }) } }),
    ...(trusted && { trusted: person }),
    ...(since && session && { deltaOf: session.id }),
    ...(markKey && { threadMark: markKey }),
  })
  const r = asked
    ? o.hub.deliver(asked, task, place)
    : o.hub.deliver(conv, task, t.side ? `${place} (side)` : place, t.side ? `side-${m.ts}` : 'main', m.user)
  if (r === 'queued' || r === 'held') k.react(m.channel, m.ts, WAITING)
  else if (r === 'sent' && k.replaying.has(m.ts)) k.unreact(m.channel, m.ts, WAITING)
  return r === 'failed' ? task : undefined
}
