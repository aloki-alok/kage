import { z } from 'zod'
import { foreignAgentRefusal } from '../../core/agents.ts'
import { openWaiting, ownerMayBeAsked } from '../../core/ledgers.ts'
import { layoutRefusal, secretRefusal } from '../../core/outbound.ts'
import type { KageTool, Result, ToolContext } from '../kage-tools.ts'
import { trustVerdict, typedAsk } from './trust-ask.ts'

type ReplyArgs = { channel: string; thread_ts: string; text: string; private?: boolean; owner_asked?: boolean; waiting?: string; waiting_on?: string; kind?: string; reach?: string; mark?: keyof typeof MARKS; wide?: boolean; tag_agent?: boolean }

const MARKS = { ack: '', question: 'scroll', answer: 'dagger_knife', done: 'crossed_swords' } as const
const ASKED_OWNER_ALREADY = 'not sent: you already asked the owner once in this thread and they replied, so their messages since are the answer. Decide it yourself and report after. A one-way step goes through its approval card, not a new ask. Post the reply again without waiting.'
const HUB_DOWN = 'not sent: Kage is restarting. Wait a few seconds and send it again.'

export function replyTool(c: ToolContext): KageTool {
  const dmLinkHeld = dmLinkGuard()
  const { Title, s } = c
  return {
    name: 'reply',
    description: `Reply to the owner in Slack: in the thread the task came from, or privately in their DM with ${Title}.`,
    shape: {
      channel: s.describe('channel attribute from the task tag'),
      thread_ts: s.describe('thread_ts attribute from the task tag'),
      text: s.describe('Slack mrkdwn text'),
      private: z.boolean().optional().describe(`true sends it to the owner's DM with ${Title} instead of the thread`),
      owner_asked: z.boolean().optional().describe('true only when the owner\'s own task line asks to post this secret in the thread. Ignored on a teammate\'s task.'),
      waiting: s.optional().describe('If this reply asks a question or offers something and the work waits on the answer: one line naming what waits ("Open a PR for lock_id?"). It stays on the waiting list until this thread gets a new task, even when the reply is private.'),
      waiting_on: s.optional().describe('With waiting: whose answer the work waits on. "owner" only for a one-way step (a deploy, a prod or database write, a merge, money, a send, a delete), a product or business choice, or something only the owner knows. Inside a job the owner already approved, decide the step yourself. A teammate\'s own test, data or decision: their Slack id (U...), and the reply tags them; it stays off the owner\'s waiting list.'),
      wide: z.boolean().optional().describe('true only for a log or code where wrapped lines are fine. Never for a table.'),
      tag_agent: z.boolean().optional().describe('On a task another agent posted: true only when that agent must read this post (the answer to its ask, or a question to it). An agent hears only posts that tag it, so acks, progress and thanks stay untagged.'),
      kind: s.optional().describe('With waiting and waiting_on owner, when a teammate\'s task needs the owner\'s yes: what kind of step it is (prod-read, ssm-relay, site-read, repo-read, or one that always asks: money, delete, send-outside, prod-deploy, prod-write, prod-shell, secret, product, owner-shell). With reach. Once the owner said yes to this kind and reach for that teammate, Kage does not ask again.'),
      reach: s.optional().describe('With kind: the exact host, site, route or repo the step touches, such as db.example.com.'),
      mark: z.enum(['ack', 'question', 'answer', 'done']).optional().describe('What this reply is, shown as a reaction on the task message: ack ("On it", no reaction), question (you need their answer to go on), answer (a quick question answered), done (the task is finished). Leave it out only on the reply that finishes the task.'),
    },
    async run(args) {
      const a = args as ReplyArgs
      const key = `${a.channel}:${a.thread_ts}`
      if (!a.private && !c.taskChannels.has(a.channel)) return { isError: true, text: 'refused: no task came from that channel; use private=true' }
      const refusal = replyRefusal(c, a, key, dmLinkHeld)
      if (refusal) return { isError: true, text: refusal }
      return await offSlackReply(c, a, key) ?? await slackReply(c, a, key)
    },
  }
}

function replyRefusal(c: ToolContext, a: ReplyArgs, key: string, dmLinkHeld: (text: string) => string | undefined) {
  return secretRefusal(a.text, { private: a.private, ownerAsked: a.owner_asked, fromOwner: c.ownerNow(key) })
    ?? (a.private ? undefined : foreignAgentRefusal(a.text, c.o.foreignAgents?.() ?? [], [c.agents.get(key)?.tag]) ?? c.unseenMention(a.text) ?? (a.channel.startsWith('D') ? undefined : dmLinkHeld(a.text)))
}

const OFF_SLACK_REPLIES: Record<string, (c: ToolContext, a: ReplyArgs, key: string) => Promise<Result | undefined> | Result | undefined> = {
  voice(c, a) {
    if (a.private) return { isError: true, text: 'refused: a voice call has no private reply' }
    if (c.o.send({ type: 'voice', text: a.text }) === false) return { isError: true, text: HUB_DOWN }
    return { text: 'spoken to the caller' }
  },
  async sms(c, a, key) {
    if (a.private) return { isError: true, text: 'refused: a text conversation has no private reply' }
    if (!c.ownerTask.has(key)) return { isError: true, text: 'refused: no task came from that text conversation' }
    if (!c.o.approve) return { isError: true, text: 'refused: a text needs the owner\'s yes on a Slack card, and this session cannot show one' }
    if (!await c.o.approve('reply', `Text to SMS contact ${a.thread_ts}: ${a.text}`, { text: a.text })) return { isError: true, text: 'The owner said no on the Slack card. Nothing was sent.' }
    if (c.o.send({ type: 'sms', text: a.text }) === false) return { isError: true, text: HUB_DOWN }
    return { text: 'texted after the owner\'s yes' }
  },
  whatsapp(c, a) {
    if (a.private) return undefined
    if (c.o.send({ type: 'wa', text: a.text }) === false) return { isError: true, text: HUB_DOWN }
    return { text: 'handed to the guard: it goes out as the owner, or to their Slack DM if the guard holds it' }
  },
  email(c, a) {
    if (a.private) return undefined
    if (c.o.send({ type: 'mail', text: a.text }) === false) return { isError: true, text: HUB_DOWN }
    return { text: 'sent by email' }
  },
}

function offSlackReply(c: ToolContext, a: ReplyArgs, key: string) {
  return Object.hasOwn(OFF_SLACK_REPLIES, a.channel) ? OFF_SLACK_REPLIES[a.channel]!(c, a, key) : undefined
}

async function slackReply(c: ToolContext, a: ReplyArgs, key: string): Promise<Result> {
  const ask = a.waiting?.trim(), on = a.waiting_on?.trim()
  if (ask && on !== 'owner' && !/^[UW][A-Z0-9]{2,}$/.test(on ?? '')) return { isError: true, text: 'not sent: with waiting, set waiting_on to "owner" or the Slack id (U...) of the person who must answer' }
  if (ask && on !== 'owner' && a.private) return { isError: true, text: 'not sent: a teammate cannot see the owner\'s DM. Ask them in the thread, or set waiting_on to "owner"' }
  if (ask && on !== 'owner' && !a.text.includes(`<@${on}>`)) a.text = `<@${on}>${/^(```|\|)/.test(a.text) ? '\n' : ' '}${a.text}`
  if (ask && on === 'owner' && !ownerMayBeAsked(c.ledger('waiting'), key, Date.now())) return { isError: true, text: ASKED_OWNER_ALREADY }
  const typed = ask && on === 'owner' ? typedAsk(c, key, a.kind, a.reach) : undefined
  if (typed && 'text' in typed) return typed
  const verdict = ask && on === 'owner' ? trustVerdict(c, key, ask, typed) : { would: '' }
  if ('result' in verdict) return verdict.result
  const layout = layoutRefusal(a.text, a)
  if (layout) return { isError: true, text: layout }
  const { via, where: at } = a.private ? await c.post(key, c.o.botDm(), c.dmThread.get(key), a.text) : await c.post(key, a.channel, a.thread_ts, a.text, a.tag_agent ? { tag: c.agents.get(key)?.tag } : {}, a.mark === 'ack')
  markTask(c, key, a.mark)
  if (ask && on === 'owner' && !openWaiting(c.ledger('waiting')).some(i => i.thread === key && i.what.trim().toLowerCase() === ask.toLowerCase())) c.append('waiting', ['open', key, c.links.get(key) ?? key, ask, ...typed ? [typed.kind, typed.reach, typed.who, verdict.would] : []])
  return { text: `sent via ${via} (${at}; pass these to edit_message or delete_message)` }
}

function markTask(c: ToolContext, key: string, mark: ReplyArgs['mark']) {
  const emoji = MARKS[mark ?? 'done']
  if (!emoji) return
  for (const origin of c.unanswered.get(key) ?? []) c.react(origin.channel, origin.ts, emoji)
  if (mark !== 'question') c.unanswered.delete(key)
}

function dmLinkGuard() {
  const held = new Set<string>()
  return (text: string) => {
    const fresh = [...text.matchAll(/slack\.com\/archives\/(D[A-Z0-9]+)\/p\d+/g)].map(x => x[0]).filter(l => !held.has(l))
    for (const l of fresh) held.add(l)
    return fresh.length ? `not sent: ${fresh.join(', ')} links a private DM, and everyone in this thread would see it. Say the message went out, in one line, with no link and no summary of what it said. If the asker asked for the link, send the same message again and it goes.` : undefined
  }
}
