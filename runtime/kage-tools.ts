// One session's tools: the state they share about its tasks, the families in runtime/tools/, its instructions, and the
// approval prompt. No transport here: plugin/server.ts serves them over MCP stdio for a tmux pane, and an
// SDK session can serve them in-process. One instance per session.
import { instructions } from '../core/instructions.ts'
import { slackReadTools } from './slack-read-tools.ts'
import type { WebClient } from '@slack/web-api'
import { mkdirSync } from 'node:fs'
import { z } from 'zod'
import { log } from './log.ts'
import type { AfkCommand } from '../core/afk.ts'
import type { Schedule } from '../core/cron.ts'
import type { ProbeArg, TuneArg } from './probe-jobs.ts'
import { addressed } from '../core/agents.ts'
import { filesFolderName } from '../core/conversations.ts'
import { plainName, teammateOf, type Sender } from '../core/gate.ts'
import { openWaiting, postedBy } from '../core/ledgers.ts'
import type { Ledgers } from './ledger.ts'
import { layoutRefusal, ownerPost, safeReply, secretRefusal, splitForSlack, type Signer } from '../core/outbound.ts'
import type { Task } from '../core/task.ts'
import type { AskOwner, Manage } from './kagelet-manager.ts'
import type { kageletMemory } from './kagelet-memory.ts'
import type { EventKind } from '../core/events.ts'
import { slackPlain } from '../core/outbound.ts'
import { slackTools } from './tools/slack-tools.ts'
import { scheduleTools } from './tools/schedule-tools.ts'
import { kageletTools } from './tools/kagelet-tools.ts'
import { ownerTools } from './tools/owner-tools.ts'
import { browserTools } from './tools/browser-tools.ts'

export type Result = { text: string; isError?: true }
export type KageTool = { name: string; description: string; shape: z.ZodRawShape; run: (args: Record<string, unknown>) => Promise<Result> }
type SessionOptions = Parameters<typeof sessionTools>[0]
// What every tool family (runtime/tools/) reads: the options, the clients, and this session's state about its tasks.
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
  jobRun: () => boolean   // the latest task this session took is a job's run, so it read outside text (never from the model's own arguments)
  need: () => string | undefined   // the kagelet whose need the latest task carries
  job: () => string | undefined   // that job's id, so its acts in its own thread are recorded under it (ADR 0017)
  ownerNow: (key: string) => boolean; ownerOnly: (a: Record<string, unknown>) => boolean; pingIn: (channel: string) => boolean
  name: string | undefined   // this session's kagelet, if it is one
}

// A job's notice in its thread as Kage, with no model: as the owner where the bot is not a member. false: not posted,
// or no stored thread, and then the event-job caller DMs the owner. It never rejects: callers drop the promise.
export const threadPing = (o: { title: string; bot: WebClient; user: WebClient; thread: (key: string) => { chat: string; thread?: string } | undefined; posted: (cells: string[]) => void }) =>
  async (key: string, text: string, job: string): Promise<boolean> => {
    const c = o.thread(key)
    if (!c) return false
    return postAsKage(o, c.chat, c.thread, text).then(r => { o.posted([c.chat, r.ts, r.by, key]); return true })
      .catch(e => { log('could not post a tripwire ping', job, e?.data?.error ?? e); return false })
  }
// A kagelet's home when its owner says "owners": a new thread in a group DM with Kage and its owners, or in Kage's
// DM when it has no owner but Kage's own. Returns the thread's link, which the kagelet file keeps.
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
// One message as Kage, the way a reply goes. The hub's own lines (the usage-limit notice) use it too.
// asOwner false: where the bot is not a member, post nothing (undefined) rather than speak from the owner's account.
type Posted = { ts: string; by: 'bot' | 'owner' }
export async function postAsKage(o: { title: string; bot: WebClient; user: WebClient }, channel: string, thread_ts: string | undefined, text: string, signer?: Signer): Promise<Posted>
export async function postAsKage(o: { title: string; bot: WebClient; user: WebClient }, channel: string, thread_ts: string | undefined, text: string, signer: Signer, asOwner: false): Promise<Posted | undefined>
export async function postAsKage(o: { title: string; bot: WebClient; user: WebClient }, channel: string, thread_ts: string | undefined, text: string,
  signer: Signer = {}, asOwner = true): Promise<Posted | undefined> {
  try {
    // The bot's own name says Kage, so its post gets the footer only when it adds who: a kagelet or a teammate.
    const r = await o.bot.chat.postMessage({ channel, thread_ts, ...signer.via || signer.asked ? ownerPost(o.title, text, signer) : { text }, unfurl_links: false })
    return { ts: r.ts!, by: 'bot' }
  } catch (e: any) {
    if (!['not_in_channel', 'channel_not_found'].includes(e?.data?.error)) throw e
    if (!asOwner) return
    // The bot is not a member here (a DM, a group DM, a private channel): post as the owner, with Kage's footer.
    // These posts carry no client_msg_id, so the gate never reads them back as tasks.
    const r = await o.user.chat.postMessage({ channel, thread_ts, ...ownerPost(o.title, text, signer), unfurl_links: false })
    return { ts: r.ts!, by: 'owner' }
  }
}

export function sessionTools(o: {
  title: string
  bot: WebClient
  user: WebClient
  botDm: () => string                                      // the owner's DM with the bot
  dir: string                                              // where sent files live
  ledgers: Ledgers                                         // shared by every session (runtime/ledger.ts)
  send: (m: { type: 'mail' | 'wa' | 'voice'; text: string }) => boolean | void // email, WhatsApp and voice replies go through the hub; false: it is down
  memory: { own: string; owner: string }
  // This thread's schedules in the hub; each runtime reaches the hub its own way (a direct call in the
  // SDK runtime, the socket from a tmux pane). add gives why the hub refused it, or nothing once the
  // hub holds it. Trust is the hub's call.
  schedules?: { add(j: Pick<Schedule, 'id' | 'cron' | 'prompt' | 'recurring' | 'lane' | 'trigger'> & { probe?: ProbeArg; shadow?: { of: string; live: string } }): string | void | Promise<string | void>; remove(id: string): void; list(): Schedule[]; tune?(id: string, t: TuneArg): string | void; hookUrl?(id: string): string | undefined; restore?(id: string): string | undefined; move?(id: string, to: string): string | undefined }
  // AFK on or off in the hub; resolves the line for the owner. Absent: AFK mode is off.
  afk?: (c: AfkCommand) => Promise<string>
  // The runner's lowest sender in the running turn (#364). Absent (tmux panes): the thread's last task decides.
  turnSender?: () => Sender | undefined
  // This session is the lane of this kagelet (core/kagelets.ts): it gets the report tool and none of the manager's.
  kagelet?: string
  // This session is the nightly dream of this kagelet: it gets propose_memory and nothing else of Kage's. The manager gets review_kagelet_memory.
  dreaming?: string
  kageletMemory?: ReturnType<typeof kageletMemory>
  // For a kagelet granted db_read (core/db-read.ts). command is read on each call (runtime/kagelets.ts readCommand). Absent: the tool does not exist.
  dbRead?: { command: () => string | undefined; maxRows: number; timeoutMs?: number }
  // The manager's side in the hub (runtime/kagelets.ts). Absent: kagelets are off (tmux panes).
  kagelets?: { list(): string; manage(a: Manage, ask?: AskOwner): Promise<string> }
  // Changes one config.json key (runtime/config-files.ts setKey), and throws why when the settings refuse the value. Absent: no set_setting tool.
  settings?: { set(key: string, value: unknown): void }
  // Put an approval card in front of the owner and wait: true only on their yes. Absent: no card (tmux panes).
  approve?: (tool: string, description: string, input: Record<string, unknown>) => Promise<boolean>
  // The event log, on this session's current run (runtime/ledger.ts runEvents). Absent: tmux panes.
  event?: (kind: EventKind, detail: string) => void
  // The owner's Chrome, through Kage's extension (connectors/browser.ts). Absent: browserToken is not set.
  browser?: { call(op: string, args: Record<string, unknown>): Promise<unknown>; block: string[] }
  meetbot?: { join(link: string): string }   // Kage's meeting bot (#63): '' when queued, else why not
  // A kagelet's report and messages, for the hub's chain router (runtime/kagelets.ts kageletRoutes).
  onReport?: (r: { needs: string; output: string }) => void
  message?: (to: string, text: string) => string
  // A kagelet's need, to Kage in its thread (runtime/kagelet-needs.ts), and Kage's answer, for the kagelet's next run.
  toManager?: (needs: string) => string
  tellKagelet?: (name: string, text: string, runNow: boolean) => string | Promise<string>
}) {
  const { title: Title, bot, user } = o
  // send_file sends only what was written in the thread's own folder: not any file on the disk, and
  // not a file another thread's task (an owner's, say) wrote.
  const filesOf = (channel: string, thread_ts: string) => `${o.dir}/files/${filesFolderName(channel, thread_ts)}`
  // posted: every message Kage posts, so it can later edit or delete its own and nothing else.
  const { add: append, text: ledger } = o.ledgers

  // Conversations a live task came from: the only places a reply may go, besides the DM.
  const taskChannels = new Set<string>()
  // channel:thread_ts -> whether the thread's latest task came from the owner.
  const ownerTask = new Map<string, boolean>()
  let job: string | undefined, need: string | undefined, jobThread = ''   // the job of the latest task, and the thread that task came from
  // The message that started each thread's latest task, so the first reply can mark it answered.
  // A list, because a question keeps the task open and the answer arrives as a new task message.
  const unanswered = new Map<string, { channel: string; ts: string }[]>()
  // channel:thread_ts -> the teammate who asked, when it was not the owner.
  const askers = new Map<string, { id: string; name: string } | undefined>()
  // channel:thread_ts -> the listed agent that posted the thread's latest task, if one did.
  const agents = new Map<string, Task['agent']>()
  // channel:ts -> the tag of each message_people post from this session ('' on the owner's task).
  // Only this session may change them, and an edit keeps the tag: the posted ledger marks them 'people',
  // which postedBy never matches, so other sessions are refused.
  const sentForPeople = new Map<string, Signer>()
  // channel:ts -> the footer of each reply this session posted from the owner's account, so an edit keeps it.
  const footers = new Map<string, Signer>()
  // channel:thread_ts -> the DM thread the owner wrote the latest task in, so a private reply answers there, not as a new DM message.
  const dmThread = new Map<string, string>()
  // channel:thread_ts -> the thread's Slack link, for the ledgers.
  const links = new Map<string, string>()
  let where = 'a thread'
  // A question's 📜 (scroll) comes off when the answer or done mark lands, so a message never reads waiting and done at once.
  const asked = new Set<string>()
  const react = (channel: string, ts: string, name: string) => {
    const c = channel === o.botDm() ? bot : user, at = `${channel}:${ts}`
    if (name === 'scroll') asked.add(at)
    else if (asked.delete(at)) void c.reactions.remove({ channel, timestamp: ts, name: 'scroll' }).catch(() => {})
    return c.reactions.add({ channel, timestamp: ts, name }).catch(() => {})
  }

  // The display name behind a <@U…> id, for the "asked by <name>" sign-off on message_people.
  const names: Record<string, string> = {}
  async function nameMentions(text: string) {
    for (const [, id] of text.matchAll(/<@([UW][A-Z0-9]+)>/g)) {
      if (names[id!]) continue
      const u = await user.users.info({ user: id! }).catch(() => null)
      const p = u?.user as { real_name?: string; name?: string; profile?: { display_name?: string } } | undefined
      if (p) names[id!] = plainName(p.profile?.display_name || p.real_name || p.name || id!)
    }
  }

  // key: the session that answered, so the retro credits a private reply to the thread it answers.
  // to: an agent this post is for. Every part tags it (core/agents.ts).
  // ack: an "On it" line, which the 🥷 pickup reaction already says, so it never goes out from the owner's account.
  async function post(key: string, channel: string, thread_ts: string | undefined, text: string, to: { tag?: string } = {}, ack = false) {
    let parts = splitForSlack(safeReply(text).trim() || '(empty reply)')
    if (to.tag) parts = addressed(parts, to.tag)
    const signer = { asked: askers.get(key)?.name, via: o.kagelet }
    let via = Title, sent: string[] = []
    for (const part of parts) {
      const r = ack ? await postAsKage(o, channel, thread_ts, part, signer, false) : await postAsKage(o, channel, thread_ts, part, signer)
      if (!r) return { via: 'nobody: not posted, because the pickup reaction already says it from the owner\'s account', where: `channel ${channel}` }
      // A job run's post into its own thread is one of that job's acts (ADR 0017); a private DM to the owner is not.
      append('posted', [channel, r.ts, r.by, key, ...job && key === jobThread && key.startsWith(`${channel}:`) ? [job] : []])
      if (r.by === 'owner') footers.set(`${channel}:${r.ts}`, signer)
      sent.push(r.ts)
      thread_ts ??= r.ts   // a long top-level post (a private reply) keeps its later parts under its first
      if (r.by === 'owner') via = `your account (${Title} is not in this conversation)`
    }
    return { via, where: `channel ${channel}, ts ${sent.join(', ')}` }
  }

  // Edit or delete one of Kage's own messages, with the token that posted it.
  async function change(a: { channel: string; ts: string; text?: string; wide?: boolean }, ping: boolean): Promise<Result> {
    // Only in a conversation this session's tasks came from, or the owner's DM: another thread's
    // session owns its own messages.
    const tag = sentForPeople.get(`${a.channel}:${a.ts}`)
    if (tag !== undefined) {
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

  // The owner's turn right now: the thread's last task is theirs, and so is every task in the running turn, so the
  // owner's mid-turn "thanks" never opens owner-only tools to a teammate's turn.
  const ownerNow = (key: string) => ownerTask.get(key) === true && (o.turnSender?.() ?? 'owner') === 'owner'
  const ownerOnly = (a: Record<string, unknown>) => ownerNow(`${String(a.channel)}:${String(a.thread_ts)}`)
  const pingIn = (channel: string) => [...ownerTask.keys()].some(k => k.startsWith(`${channel}:`) && ownerNow(k))
  const c: ToolContext = { o, Title, bot, user, s: z.string(), taskChannels, ownerTask, unanswered, askers, agents, sentForPeople, dmThread, links, react, post, change, nameMentions, names, append, ledger, filesOf, jobRun: () => job !== undefined || need !== undefined, job: () => job, need: () => need, ownerNow, ownerOnly, pingIn, name: o.kagelet }
  // Slack reads as the owner: never for an agent's task made with the owner's token, a kagelet or its dream (their threads may hold other people).
  const ownerRead = (a: Record<string, unknown>) => ownerOnly(a) && !agents.get(`${a.channel}:${a.thread_ts}`)
  const reads = o.kagelet || o.dreaming ? [] : slackReadTools(user, ownerRead)
  // Kept in this order: the reply tools first, as a session reads them.
  const tools = [...slackTools(c), ...scheduleTools(c), ...kageletTools(c), ...ownerTools(c), ...browserTools(c), ...reads]
  const browser = o.browser

  return {
    tools,
    instructions: instructions(Title, o.memory, !!browser, o.kagelet ? { kagelet: o.kagelet } : o.dreaming ? { dreaming: o.dreaming } : undefined),
    // A task arrived for this session: remember where it came from and who sent it.
    onTask(m: Task) {
      const key = `${m.meta.channel}:${m.meta.thread_ts}`
      try { mkdirSync(filesOf(m.meta.channel, m.meta.thread_ts), { recursive: true, mode: 0o700 }) } catch (e) { log('files folder', e) }
      taskChannels.add(m.meta.channel)
      ownerTask.set(key, m.fromOwner === true)
      job = m.job
      need = m.need?.name
      jobThread = key
      askers.set(key, teammateOf(m.content))
      agents.set(key, m.agent)
      if (m.origin.channel === o.botDm() && m.origin.thread) dmThread.set(key, m.origin.thread)
      else if (m.origin.ts) dmThread.delete(key)
      if (m.origin.ts && m.meta.channel !== 'email' && m.meta.channel !== 'whatsapp' && m.meta.channel !== 'voice') unanswered.set(key, [...unanswered.get(key) ?? [], m.origin])
      where = m.meta.permalink ? `<${m.meta.permalink}|${m.meta.place}>` : m.meta.place
      links.set(key, m.meta.permalink || m.meta.place)
      // A scheduled run is not the owner answering. A row only when something was open keeps the file to real answers.
      if (!m.scheduled && openWaiting(ledger('waiting')).some(i => i.thread === key)) append('waiting', ['answered', key, '', ''])
    },
    // Ask the owner, in their DM, to approve one tool call. Rejects when the prompt did not post.
    async askOwner(p: { id: string; tool: string; description: string; preview: string }) {
      const MAX = 2500
      // The description may carry a model's words: cap it, and defuse <url|text> so a link cannot rename what is approved.
      const description = slackPlain((p.description.length > 400 ? `${p.description.slice(0, 400)}...` : p.description).replaceAll('```', "'''").replace(/\s*\n\s*/g, ' '))
      const preview = p.preview.replaceAll('```', "'''")
      const cut = preview.length > MAX ? `${preview.slice(0, MAX)}\n... ${preview.length - MAX} more chars NOT shown. Deny unless you checked it in the terminal.` : preview
      const r = await bot.chat.postMessage({
        channel: o.botDm(),
        text: `*Approve?* ${p.tool.replace(/^mcp__(.+__)?/, '').replaceAll('_', ' ')} · ${where}${description ? `\n${description}` : ''}\n\`\`\`${cut}\`\`\`\nReply \`yes\` or \`no\` in this thread`,
      })
      // The owner's yes under this message counts only because of this row (cardAt in core/ledgers.ts).
      append('posted', [o.botDm(), r.ts!, 'card', p.id])
    },
  }
}

