import { z } from 'zod'
import { foreignAgentRefusal } from '../../core/agents.ts'
import { layoutRefusal, ownerPost, safeReply, secretRefusal } from '../../core/outbound.ts'
import type { KageTool, Result, ToolContext } from '../kage-tools.ts'

type PeopleArgs = { channel: string; thread_ts: string; users: string[]; text: string; from?: string }

export function messagePeopleTool(c: ToolContext): KageTool {
  const { Title, s } = c
  return {
    name: 'message_people',
    description: `Tell people something in Slack: posts in the group DM of the owner and these people, from the owner's account (${Title} cannot join a group DM), with ${Title}'s footer under it so people see it is ${Title}. The footer names who asked on a teammate's task, or whom the news is from when you pass from on the owner's, and that person is added to the group. Returns the link: share it in the task thread with reply.`,
    shape: {
      channel: s.describe('channel attribute from the task tag'),
      thread_ts: s.describe('thread_ts attribute from the task tag'),
      users: z.array(s).describe('Slack user ids (U...) of the people to tell, at most 8; the owner is always in the group'),
      from: s.optional().describe('Slack user id of the person the message is from, when the owner passes on someone else\'s news. Ignored on a teammate\'s task: it is always the asker.'),
      text: s.describe('the message, complete on its own: what and when. The tool adds the footer, so do not write "From X:" or sign it'),
    },
    async run(args) {
      const a = args as PeopleArgs
      const key = `${a.channel}:${a.thread_ts}`
      const fromPhone = a.channel === 'whatsapp' && c.ownerOnly(a)
      if (!c.taskChannels.has(a.channel) || a.channel === 'email' || (a.channel === 'whatsapp' && !fromPhone) || (a.channel === 'voice' && !c.ownerOnly(a))) return { isError: true, text: 'refused: only a task from a Slack thread or the owner\'s own call may message people' }
      const refusal = peopleRefusal(c, a)
      if (refusal) return { isError: true, text: refusal }
      const asker = c.ownerNow(key) ? undefined : c.askers.get(key) ?? { id: '', name: 'A teammate' }
      if (!asker && a.from) await c.nameMentions(`<@${a.from}>`)
      const signer = asker ?? (a.from ? { id: a.from, name: c.names[a.from] ?? a.from } : undefined)
      const people = [...new Set([...a.users, ...signer?.id ? [signer.id] : []])]
      if (people.length > 8) return { isError: true, text: 'refused: name 1 to 8 people by their Slack user id (U...)' }
      const secret = secretRefusal(a.text, { fromOwner: !asker })
      if (secret) return { isError: true, text: secret }
      const layout = layoutRefusal(a.text)
      if (layout) return { isError: true, text: layout }
      if (fromPhone) {
        const no = await phoneApproval(c, people, a.text)
        if (no) return no
      }
      return postToPeople(c, people, a.text, asker ? { asked: asker.name } : signer ? { from: signer.name } : {})
    },
  }
}

function peopleRefusal(c: ToolContext, a: PeopleArgs) {
  const unseen = c.unseenMention(a.text, a.users)
  if (unseen) return unseen
  const toAgent = foreignAgentRefusal([a.text, ...[...a.users, ...a.from ? [a.from] : []].map(u => `<@${u}>`)].join(' '), c.o.foreignAgents?.() ?? [])
  if (toAgent) return toAgent
  const ids = [...a.users, ...a.from ? [a.from] : []]
  if (!a.users.length || ids.some(u => !/^[UW][A-Z0-9]+$/.test(u))) return 'refused: name 1 to 8 people by their Slack user id (U...)'
  return undefined
}

async function phoneApproval(c: ToolContext, people: string[], text: string): Promise<Result | undefined> {
  if (!c.o.approve) return { isError: true, text: 'refused: from WhatsApp this needs the owner\'s yes on a Slack card, and this session cannot show one. Tell them to ask in Slack.' }
  await c.nameMentions(people.map(u => `<@${u}>`).join(' '))
  if (!await c.o.approve('message_people', `From WhatsApp: message ${people.map(u => `${c.names[u] ?? 'someone'} (${u})`).join(', ')}: ${text}`, { users: people, text })) return { isError: true, text: 'The owner said no on the Slack card. Nothing was sent.' }
  return undefined
}

async function postToPeople(c: ToolContext, people: string[], text: string, foot: { asked?: string; from?: string }): Promise<Result> {
  let dm: string
  try {
    dm = (await c.user.conversations.open({ users: people.join(',') })).channel!.id!
  } catch (e: any) {
    if (e?.data?.error === 'missing_scope') return { isError: true, text: `not sent: the Slack app needs the user scopes mpim:write and im:write. Put a draft in the group DM for the owner to send instead.` }
    throw e
  }
  const r = await c.user.chat.postMessage({ channel: dm, ...ownerPost(c.Title, safeReply(text).trim(), foot), unfurl_links: false })
  c.append('posted', [dm, r.ts!, 'people'])
  c.sentForPeople.set(`${dm}:${r.ts}`, foot)
  const link = await c.user.chat.getPermalink({ channel: dm, message_ts: r.ts! }).then(x => x.permalink ?? '').catch(() => '')
  return { text: `sent from the owner's account, marked ${c.Title}: ${link || dm} (channel ${dm}, ts ${r.ts}; pass these to edit_message or delete_message)` }
}
