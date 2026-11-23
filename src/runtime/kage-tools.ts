import { instructions } from '../core/instructions.ts'
import { slackReadTools } from './slack-read-tools.ts'
import type { WebClient } from '@slack/web-api'
import { mkdirSync } from 'node:fs'
import { z } from 'zod'
import { log } from './log.ts'
import type { AfkCommand } from '../core/afk.ts'
import type { Schedule } from '../core/cron.ts'
import type { ProbeArg, TuneArg } from './probe-jobs.ts'
import type { ChannelReply } from './protocol.ts'
import { addressed, foreignAgentRefusal, mentionedIds } from '../core/agents.ts'
import { filesFolderName } from '../core/conversations.ts'
import { plainName, teammateOf, type Sender } from '../core/gate.ts'
import { openWaiting, postedBy } from '../core/ledgers.ts'
import type { Ledgers } from './ledger.ts'
import { layoutRefusal, ownerPost, safeReply, secretRefusal, splitForSlack, type Signer } from '../core/outbound.ts'
import type { Task } from '../core/task.ts'
import type { AskOwner, Manage } from './kagelets/manager.ts'
import type { kageletMemory } from './kagelets/memory.ts'
import type { EventKind } from '../core/events.ts'
import { slackPlain } from '../core/outbound.ts'
import { slackTools } from './tools/slack-tools.ts'
import { scheduleTools } from './tools/schedule-tools.ts'
import { kageletTools } from './tools/kagelet-tools.ts'
import { ownerTools } from './tools/owner-tools.ts'
import { dreamTools } from './tools/dream-tools.ts'
import type { DreamLesson } from '../core/dream.ts'
import { browserTools } from './tools/browser-tools.ts'
import { screenTools } from './tools/screen-tools.ts'
import type { ScreenRecorder } from './screen.ts'
import { smsTools, type SmsCampaigns } from './tools/sms-tools.ts'
import { answersInThread } from '../core/blocks.ts'

export type Result = { text: string; isError?: true }
export type KageTool = { name: string; description: string; shape: z.ZodRawShape; run: (args: Record<string, unknown>) => Promise<Result> }
export type ToolContext = {
  o: SessionOptions; Title: string; bot: WebClient; user: WebClient; s: z.ZodString
  taskChannels: Set<string>; ownerTask: Map<string, boolean>; unanswered: Map<string, { channel: string; ts: string }[]>
  askers: Map<string, { id: string; name: string } | undefined>; agents: Map<string, Task['agent']>; sentForPeople: Map<string, Signer>
  dmThread: Map<string, string>; links: Map<string, string>; names: Record<string, string>
  react: (channel: string, ts: string, name: string) => void
  post: (key: string, channel: string, thread_ts: string | undefined, text: string, to?: { tag?: string }, ack?: boolean) => Promise<{ via: string; where: string }>
  change: (a: { channel: string; ts: string; text?: string; wide?: boolean }, ping: boolean) => Promise<Result>
  nameMentions: (text: string) => Promise<void>
  append: Ledgers['add']; ledger: Ledgers['text']; filesOf: (channel: string, thread_ts: string) => string
  jobRun: () => boolean
  need: () => string | undefined
  job: () => string | undefined
  ownerNow: (key: string) => boolean; ownerOnly: (a: Record<string, unknown>) => boolean; ownerActs: (a: Record<string, unknown>) => boolean; pingIn: (channel: string) => boolean
  name: string | undefined
  unseenMention: (text: string, also?: readonly string[]) => string | undefined
}

export const threadPing = (o: { title: string; bot: WebClient; user: WebClient; thread: (key: string) => { chat: string; thread?: string } | undefined; posted: (cells: string[]) => void }) =>
  async (key: string, text: string, job: string): Promise<boolean> => {
    const c = o.thread(key)
    if (!c) return false
    return postAsKage(o, c.chat, c.thread, text).then(r => { o.posted([c.chat, r.ts, r.by, key]); return true })
      .catch(e => { log('could not post a tripwire ping', job, e?.data?.error ?? e); return false })
  }
export const homeThread = (o: { title: string; bot: WebClient; user: WebClient; ids: { owner: string; bot: string; botDm: string } }) =>
  async (owners: string[], name: string): Promise<string> => {
    const others = [...new Set(owners)].filter(u => u !== o.ids.owner)
    const channel = others.length ? (await o.user.conversations.open({ users: [o.ids.bot, ...others].join(',') })).channel?.id : o.ids.botDm
    if (!channel) throw new Error('Slack opened no group DM')
    const r = await postAsKage(o, channel, undefined, `Kagelet *${name}* posts its work in this thread.`)
    const link = (await o.user.chat.getPermalink({ channel, message_ts: r.ts })).permalink
    if (!link) throw new Error('Slack gave no link for the home thread')
    return link
  }
type Posted = { ts: string; by: 'bot' | 'owner' }
export async function postAsKage(o: { title: string; bot: WebClient; user: WebClient }, channel: string, thread_ts: string | undefined, text: string, signer?: Signer): Promise<Posted>
export async function postAsKage(o: { title: string; bot: WebClient; user: WebClient }, channel: string, thread_ts: string | undefined, text: string, signer: Signer, asOwner: false): Promise<Posted | undefined>
export async function postAsKage(o: { title: string; bot: WebClient; user: WebClient }, channel: string, thread_ts: string | undefined, text: string,
  signer: Signer = {}, asOwner = true): Promise<Posted | undefined> {
  try {
    const r = await o.bot.chat.postMessage({ channel, thread_ts, ...signer.via || signer.asked || signer.scheduled ? ownerPost(o.title, text, signer) : { text }, unfurl_links: false })
    return { ts: r.ts!, by: 'bot' }
  } catch (e: any) {
    if (!['not_in_channel', 'channel_not_found'].includes(e?.data?.error)) throw e
    if (!asOwner) return
    const r = await o.user.chat.postMessage({ channel, thread_ts, ...ownerPost(o.title, text, signer), unfurl_links: false })
    return { ts: r.ts!, by: 'owner' }
  }
}

type SessionOptions = {
  cardOut?: (c: { id: string; tool: string; description: string; place: string; preview: string }) => void
  title: string
  bot: WebClient
  user: WebClient
  botDm: () => string
  dir: string
  ledgers: Ledgers
  send: (m: ChannelReply) => boolean | void
  memory: { own: string; owner: string }
  schedules?: { add(j: Pick<Schedule, 'id' | 'cron' | 'prompt' | 'recurring' | 'lane' | 'trigger' | 'needs'> & { probe?: ProbeArg; shadow?: { of: string; live: string } }): string | void | Promise<string | void>; remove(id: string): void; list(): Schedule[]; tune?(id: string, t: TuneArg): string | void; hookUrl?(id: string): string | undefined; restore?(id: string): string | undefined; move?(id: string, to: string): string | undefined }
  afk?: (c: AfkCommand) => Promise<string>
  turnSender?: () => Sender | undefined
  kagelet?: string
  dreaming?: string
  dreamLessons?: (lessons: DreamLesson[]) => string
  kageletMemory?: ReturnType<typeof kageletMemory>
  dbRead?: { command: () => string | undefined; maxRows: number; timeoutMs?: number }
  kagelets?: { list(): string; manage(a: Manage, ask?: AskOwner): Promise<string> }
  settings?: { set(key: string, value: unknown): void }
  approve?: (tool: string, description: string, input: Record<string, unknown>) => Promise<boolean>
  event?: (kind: EventKind, detail: string) => void
  browser?: { call(op: string, args: Record<string, unknown>): Promise<unknown>; block: string[] }
  meetbot?: { join(link: string): string }
  sms?: SmsCampaigns
  screen?: ScreenRecorder
  foreignAgents?: () => readonly string[]
  onReport?: (r: { needs: string; output: string }) => void
  message?: (to: string, text: string) => string
  toManager?: (needs: string) => string
  tellKagelet?: (name: string, text: string, runNow: boolean) => string | Promise<string>
}
type Thread = {
  o: SessionOptions; Title: string; bot: WebClient; user: WebClient
  append: Ledgers['add']; ledger: Ledgers['text']; filesOf: (channel: string, thread_ts: string) => string
  taskChannels: Set<string>; ownerTask: Map<string, boolean>; unanswered: Map<string, { channel: string; ts: string }[]>
  askers: Map<string, { id: string; name: string } | undefined>; agents: Map<string, Task['agent']>
  sentForPeople: Map<string, Signer>; footers: Map<string, Signer>; scheduledRun: Map<string, boolean>
  dmThread: Map<string, string>; links: Map<string, string>; asked: Set<string>
  names: Record<string, string>; seenIds: Set<string>; heldOnce: Set<string>
  job?: string; need?: string; jobThread: string; where: string
}

export function sessionTools(o: SessionOptions) {
  const t: Thread = {
    o, Title: o.title, bot: o.bot, user: o.user, append: o.ledgers.add, ledger: o.ledgers.text,
    filesOf: (channel: string, thread_ts: string) => `${o.dir}/files/${filesFolderName(channel, thread_ts)}`,
    taskChannels: new Set(), ownerTask: new Map(), unanswered: new Map(), askers: new Map(), agents: new Map(),
    sentForPeople: new Map(), footers: new Map(), scheduledRun: new Map(), dmThread: new Map(), links: new Map(), asked: new Set(),
    names: {}, seenIds: new Set(), heldOnce: new Set(), jobThread: '', where: 'a thread',
  }
  const { Title, bot, user, taskChannels, ownerTask, unanswered, askers, agents, sentForPeople, dmThread, links, names, append, ledger, filesOf } = t
  const ownerNow = (key: string) => ownerTask.get(key) === true && (o.turnSender?.() ?? 'owner') === 'owner'
  const ownerOnly = (a: Record<string, unknown>) => ownerNow(`${String(a.channel)}:${String(a.thread_ts)}`)
  const ownerActs = (a: Record<string, unknown>) => ownerOnly(a) && a.channel !== 'voice' && !agents.get(`${a.channel}:${a.thread_ts}`)
  const pingIn = (channel: string) => [...ownerTask.keys()].some(k => k.startsWith(`${channel}:`) && ownerNow(k))
  const c: ToolContext = {
    o, Title, bot, user, s: z.string(), taskChannels, ownerTask, unanswered, askers, agents, sentForPeople, dmThread, links,
    react: (channel, ts, name) => react(t, channel, ts, name), post: (...a) => post(t, ...a), change: (a, ping) => change(t, a, ping), nameMentions: text => nameMentions(t, text),
    names, append, ledger, filesOf, jobRun: () => t.job !== undefined || t.need !== undefined, job: () => t.job, need: () => t.need, ownerNow, ownerOnly, ownerActs, pingIn, name: o.kagelet, unseenMention: (text, also) => unseenMention(t, text, also),
  }
  const ownerRead = (a: Record<string, unknown>) => ownerOnly(a) && !agents.get(`${a.channel}:${a.thread_ts}`)
  const reads = o.kagelet || o.dreaming ? [] : slackReadTools(user, ownerRead)
  const tools = [...slackTools(c), ...scheduleTools(c), ...kageletTools(c), ...ownerTools(c), ...smsTools(c), ...browserTools(c), ...screenTools(c), ...dreamTools(c), ...reads]
  return {
    tools,
    instructions: instructions(Title, o.memory, !!o.browser, o.kagelet ? { kagelet: o.kagelet } : o.dreaming ? { dreaming: o.dreaming } : undefined),
    onTask: (m: Task) => onTask(t, m),
    askOwner: (p: { id: string; tool: string; description: string; preview: string }) => askOwner(t, p),
  }
}

function react({ o, bot, user, asked }: Thread, channel: string, ts: string, name: string) {
  const c = channel === o.botDm() ? bot : user, at = `${channel}:${ts}`
  if (name === 'scroll') asked.add(at)
  else if (asked.delete(at)) void c.reactions.remove({ channel, timestamp: ts, name: 'scroll' }).catch(() => {})
  return c.reactions.add({ channel, timestamp: ts, name }).catch(() => {})
}

function unseenMention({ seenIds, heldOnce }: Thread, text: string, also: readonly string[] = []) {
  const ids = mentionedIds(text).filter(id => !seenIds.has(id) && !also.includes(id))
  const fresh = ids.filter(id => !heldOnce.has(id))
  for (const id of ids) { if (heldOnce.has(id)) seenIds.add(id); else heldOnce.add(id) }
  return fresh.length ? `not sent: ${fresh.map(id => `<@${id}>`).join(', ')} is not anyone in this thread's tasks, so the mention may be a wrong or remembered id that pings a stranger. Check who it is; if it is right, send the same message again and it goes.` : undefined
}

async function nameMentions({ user, names }: Thread, text: string) {
  for (const id of mentionedIds(text)) {
    if (names[id!]) continue
    const u = await user.users.info({ user: id! }).catch(() => null)
    const p = u?.user as { real_name?: string; name?: string; profile?: { display_name?: string } } | undefined
    if (p) names[id!] = plainName(p.profile?.display_name || p.real_name || p.name || id!)
  }
}

async function post(t: Thread, key: string, channel: string, thread_ts: string | undefined, text: string, to: { tag?: string } = {}, ack = false) {
  const { o, Title, askers, scheduledRun, append, footers } = t
  let parts = splitForSlack(safeReply(text).trim() || '(empty reply)')
  if (to.tag) parts = addressed(parts, to.tag)
  const signer = { asked: askers.get(key)?.name, via: o.kagelet, scheduled: scheduledRun.get(key) && channel !== o.botDm() }
  let via = Title, sent: string[] = []
  for (const part of parts) {
    const r = ack ? await postAsKage(o, channel, thread_ts, part, signer, false) : await postAsKage(o, channel, thread_ts, part, signer)
    if (!r) return { via: 'nobody: not posted, because the pickup reaction already says it from the owner\'s account', where: `channel ${channel}` }
    append('posted', [channel, r.ts, r.by, key, ...t.job && key === t.jobThread && key.startsWith(`${channel}:`) ? [t.job] : []])
    if (r.by === 'owner') footers.set(`${channel}:${r.ts}`, signer)
    sent.push(r.ts)
    thread_ts ??= r.ts
    if (r.by === 'owner') via = `your account (${Title} is not in this conversation)`
  }
  return { via, where: `channel ${channel}, ts ${sent.join(', ')}` }
}

async function change(t: Thread, a: { channel: string; ts: string; text?: string; wide?: boolean }, ping: boolean): Promise<Result> {
  const { o, Title, bot, user, agents, sentForPeople, taskChannels, append, ledger, footers } = t
  const toAgent = a.text === undefined ? undefined : foreignAgentRefusal(a.text, o.foreignAgents?.() ?? [], [...agents].filter(([k]) => k.startsWith(`${a.channel}:`)).map(([, v]) => v?.tag))
  if (toAgent) return { isError: true, text: toAgent }
  const tag = sentForPeople.get(`${a.channel}:${a.ts}`)
  if (tag !== undefined) return changeForPeople(t, a, tag)
  if (a.channel !== o.botDm() && !taskChannels.has(a.channel)) return { isError: true, text: `refused: no task in this session came from ${a.channel}` }
  const by = postedBy(ledger('posted'), a.channel, a.ts)
  if (!by) return { isError: true, text: `refused: ${Title} did not post that message, or it is already deleted` }
  const client = by === 'bot' ? bot : user
  if (a.text === undefined) {
    await client.chat.delete({ channel: a.channel, ts: a.ts })
    append('posted', [a.channel, a.ts, 'deleted'])
    return { text: 'deleted' }
  }
  const refusal = secretRefusal(a.text, { fromOwner: ping })
  if (refusal) return { isError: true, text: refusal }
  const layout = layoutRefusal(a.text, a)
  if (layout) return { isError: true, text: layout }
  const text = safeReply(a.text).trim()
  await client.chat.update({ channel: a.channel, ts: a.ts, ...by === 'owner' ? ownerPost(Title, text, footers.get(`${a.channel}:${a.ts}`)) : { text } })
  return { text: 'edited' }
}

async function changeForPeople({ Title, user, append, sentForPeople }: Thread, a: { channel: string; ts: string; text?: string }, tag: Signer): Promise<Result> {
  if (a.text === undefined) {
    await user.chat.delete({ channel: a.channel, ts: a.ts })
    append('posted', [a.channel, a.ts, 'deleted'])
    sentForPeople.delete(`${a.channel}:${a.ts}`)
    return { text: 'deleted' }
  }
  const no = secretRefusal(a.text, { fromOwner: !tag.asked && !tag.from }) ?? layoutRefusal(a.text)
  if (no) return { isError: true, text: no }
  await user.chat.update({ channel: a.channel, ts: a.ts, ...ownerPost(Title, safeReply(a.text).trim(), tag) })
  return { text: 'edited' }
}

function onTask(t: Thread, m: Task) {
  const { o, filesOf, taskChannels, ownerTask, seenIds, askers, scheduledRun, agents, dmThread, unanswered, links, append, ledger } = t
  const key = `${m.meta.channel}:${m.meta.thread_ts}`
  try { mkdirSync(filesOf(m.meta.channel, m.meta.thread_ts), { recursive: true, mode: 0o700 }) } catch (e) { log('files folder', e) }
  taskChannels.add(m.meta.channel)
  ownerTask.set(key, m.fromOwner === true)
  for (const [, id] of m.content.matchAll(/\b([UW][A-Z0-9]+)\b/g)) seenIds.add(id!)
  t.job = m.job
  t.need = m.need?.name
  t.jobThread = key
  askers.set(key, teammateOf(m.content))
  scheduledRun.set(key, m.scheduled === true)
  agents.set(key, m.agent)
  if (m.origin.channel === o.botDm() && m.origin.thread) dmThread.set(key, m.origin.thread)
  else if (m.origin.ts) dmThread.delete(key)
  if (answersInThread(m)) unanswered.set(key, [...unanswered.get(key) ?? [], m.origin])
  t.where = m.meta.permalink ? `<${m.meta.permalink}|${m.meta.place}>` : m.meta.place
  links.set(key, m.meta.permalink || m.meta.place)
  if (!m.scheduled && openWaiting(ledger('waiting')).some(i => i.thread === key)) append('waiting', ['answered', key, '', ''])
}

async function askOwner(t: Thread, p: { id: string; tool: string; description: string; preview: string }) {
  const { o, bot, append } = t
  const MAX = 2500
  const description = slackPlain((p.description.length > 400 ? `${p.description.slice(0, 400)}...` : p.description).replaceAll('```', "'''").replace(/\s*\n\s*/g, ' '))
  const preview = p.preview.replaceAll('```', "'''")
  const cut = preview.length > MAX ? `${preview.slice(0, MAX)}\n... ${preview.length - MAX} more chars NOT shown. Deny unless you checked it in the terminal.` : preview
  const r = await bot.chat.postMessage({
    channel: o.botDm(),
    text: `*Approve?* ${p.tool.replace(/^mcp__(.+__)?/, '').replaceAll('_', ' ')} · ${t.where}${description ? `\n${description}` : ''}\n\`\`\`${cut}\`\`\`\nReply \`yes\` or \`no\` in this thread`,
  })
  append('posted', [o.botDm(), r.ts!, 'card', p.id])
  o.cardOut?.({ id: p.id, tool: p.tool, description, place: t.where, preview })
}
