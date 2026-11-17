// A session's Slack tools: reply, edit and delete its own posts, tell people, attach a file, the waiting list, the prod log,
// and a post as Kage where no task came from. The shared state they read is built in runtime/kage-tools.ts.
import { readFileSync, realpathSync, statSync } from 'node:fs'
import { basename, extname } from 'node:path'
import { z } from 'zod'
import { openWaiting } from '../../core/ledgers.ts'
import { findSecret, layoutRefusal, ownerPost, safeReply, secretRefusal, splitForSlack } from '../../core/outbound.ts'
import type { KageTool, ToolContext } from '../kage-tools.ts'

// The reaction each kind of reply leaves on the task message. An ack leaves none: 🥷 already says "picked up".
// Ninja set, picked by the owner: 📜 a scroll back to you (waits on your answer), 🗡️ a quick strike, ⚔️ the task done.
const MARKS = { ack: '', question: 'scroll', answer: 'dagger_knife', done: 'crossed_swords' } as const
const HUB_DOWN = 'not sent: Kage is restarting. Wait a few seconds and send it again.'

export function slackTools(c: ToolContext): KageTool[] {
  const { o, Title, bot, user, s, taskChannels, ownerTask, unanswered, askers, agents, sentForPeople, dmThread, links, react, post, change, nameMentions, names, append, ledger, filesOf, ownerOnly, pingIn, name } = c
  const tools: KageTool[] = [{
    name: 'reply',
    description: `Reply to the owner in Slack: in the thread the task came from, or privately in their DM with ${Title}.`,
    shape: {
      channel: s.describe('channel attribute from the task tag'),
      thread_ts: s.describe('thread_ts attribute from the task tag'),
      text: s.describe('Slack mrkdwn text'),
      private: z.boolean().optional().describe(`true sends it to the owner's DM with ${Title} instead of the thread`),
      owner_asked: z.boolean().optional().describe('true only when the owner\'s own task line asks to post this secret in the thread. Ignored on a teammate\'s task.'),
      waiting: s.optional().describe('If this reply asks a question or offers something and the work waits on the answer: one line naming what waits ("Open a PR for lock_id?"). It stays on the waiting list until this thread gets a new task, even when the reply is private.'),
      wide: z.boolean().optional().describe('true only for a log or code where wrapped lines are fine. Never for a table.'),
      tag_agent: z.boolean().optional().describe('On a task another agent posted: true only when that agent must read this post (the answer to its ask, or a question to it). An agent hears only posts that tag it, so acks, progress and thanks stay untagged.'),
      no_reply_needed: z.boolean().optional().describe('With tag_agent, when you expect nothing back (a final answer). It ends the post with "(no reply needed)", and the other agent stays quiet.'),
      mark: z.enum(['ack', 'question', 'answer', 'done']).optional().describe('What this reply is, shown as a reaction on the task message: ack ("On it", no reaction), question (you need their answer to go on), answer (a quick question answered), done (the task is finished). Leave it out only on the reply that finishes the task.'),
    },
    async run(args) {
      const a = args as { channel: string; thread_ts: string; text: string; private?: boolean; owner_asked?: boolean; waiting?: string; mark?: keyof typeof MARKS; wide?: boolean; tag_agent?: boolean; no_reply_needed?: boolean }
      const key = `${a.channel}:${a.thread_ts}`
      // A reply goes back where a task came from, never to a channel picked from the conversation.
      if (!a.private && !taskChannels.has(a.channel)) return { isError: true, text: 'refused: no task came from that channel; use private=true' }
      const refusal = secretRefusal(a.text, { private: a.private, ownerAsked: a.owner_asked, fromOwner: ownerTask.get(key) === true })
      if (refusal) return { isError: true, text: refusal }
      if (a.channel === 'voice') {
        // A voice reply is spoken to the caller, nowhere else: not Slack, not the owner's DM.
        if (a.private) return { isError: true, text: 'refused: a voice call has no private reply' }
        if (o.send({ type: 'voice', text: a.text }) === false) return { isError: true, text: HUB_DOWN }
        return { text: 'spoken to the caller' }
      }
      if ((a.channel === 'whatsapp' || a.channel === 'email') && !a.private) {
        if (o.send({ type: a.channel === 'email' ? 'mail' : 'wa', text: a.text }) === false) return { isError: true, text: HUB_DOWN }
        return { text: a.channel === 'email' ? 'sent by email' : 'handed to the guard: it goes out as the owner, or to their Slack DM if the guard holds it' }
      }
      const layout = layoutRefusal(a.text, a)
      if (layout) return { isError: true, text: layout }
      const { via, where: at } = a.private ? await post(key, o.botDm(), dmThread.get(key), a.text) : await post(key, a.channel, a.thread_ts, a.text, a.tag_agent ? { tag: agents.get(key)?.tag, noReply: a.no_reply_needed } : {}, a.mark === 'ack')
      // A question keeps the task open, so its final reply still marks the task.
      const emoji = MARKS[a.mark ?? 'done']
      if (emoji) {
        for (const origin of unanswered.get(key) ?? []) react(origin.channel, origin.ts, emoji)
        if (a.mark !== 'question') unanswered.delete(key)
      }
      const ask = a.waiting?.trim()
      if (ask && !openWaiting(ledger('waiting')).some(i => i.thread === key && i.what.trim().toLowerCase() === ask.toLowerCase())) append('waiting', ['open', key, links.get(key) ?? key, ask])
      return { text: `sent via ${via} (${at}; pass these to edit_message or delete_message)` }
    },
  }, {
    name: 'edit_message',
    description: `Change the text of a message ${Title} posted (channel and ts come from the reply result). Use it to fix a wrong or outdated reply.`,
    shape: { channel: s, ts: s, text: s.describe('the full new Slack mrkdwn text'), wide: z.boolean().optional().describe('as on reply') },
    run: args => change(args as { channel: string; ts: string; text: string; wide?: boolean }, pingIn(String(args.channel))),
  }, {
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
      const a = args as { channel: string; thread_ts: string; users: string[]; text: string; from?: string }
      const key = `${a.channel}:${a.thread_ts}`
      // A call counts only when the owner proved it with the one-time code (connectors/voice.ts): a stranger may be talking.
      // WhatsApp is the owner's phone, easier to steal than Slack: its task may message people only after the owner's yes on a Slack card.
      const fromPhone = a.channel === 'whatsapp' && ownerOnly(a)
      if (!taskChannels.has(a.channel) || a.channel === 'email' || (a.channel === 'whatsapp' && !fromPhone) || (a.channel === 'voice' && !ownerOnly(a))) return { isError: true, text: 'refused: only a task from a Slack thread or the owner\'s own call may message people' }
      // Anyone but the owner gets the tag, even when their task line names no teammate.
      const asker = ownerTask.get(key) === true ? undefined : askers.get(key) ?? { id: '', name: 'A teammate' }
      const ids = [...a.users, ...a.from ? [a.from] : []]
      if (!a.users.length || ids.some(u => !/^[UW][A-Z0-9]+$/.test(u))) return { isError: true, text: 'refused: name 1 to 8 people by their Slack user id (U...)' }
      // Signed by the asker on a teammate's task, whatever from says; on the owner's, by from if given.
      if (!asker && a.from) await nameMentions(`<@${a.from}>`)
      const signer = asker ?? (a.from ? { id: a.from, name: names[a.from] ?? a.from } : undefined)
      // The person a message is signed for always sees it.
      const people = [...new Set([...a.users, ...signer?.id ? [signer.id] : []])]
      if (people.length > 8) return { isError: true, text: 'refused: name 1 to 8 people by their Slack user id (U...)' }
      const refusal = secretRefusal(a.text, { fromOwner: !asker })
      if (refusal) return { isError: true, text: refusal }
      const layout = layoutRefusal(a.text)
      if (layout) return { isError: true, text: layout }
      // Asked last, after every refusal, so the owner never says yes to a message that would not go. The card names
      // everyone it reaches, by name and id, the person it is sent for too.
      if (fromPhone) {
        if (!o.approve) return { isError: true, text: 'refused: from WhatsApp this needs the owner\'s yes on a Slack card, and this session cannot show one. Tell them to ask in Slack.' }
        await nameMentions(people.map(u => `<@${u}>`).join(' '))
        if (!await o.approve('message_people', `From WhatsApp: message ${people.map(u => `${names[u] ?? 'someone'} (${u})`).join(', ')}: ${a.text}`, { users: people, text: a.text })) return { isError: true, text: 'The owner said no on the Slack card. Nothing was sent.' }
      }
      const foot = asker ? { asked: asker.name } : signer ? { from: signer.name } : {}
      let dm: string
      try {
        dm = (await user.conversations.open({ users: people.join(',') })).channel!.id!
      } catch (e: any) {
        if (e?.data?.error === 'missing_scope') return { isError: true, text: `not sent: the Slack app needs the user scopes mpim:write and im:write. Put a draft in the group DM for the owner to send instead.` }
        throw e
      }
      // Sent from the owner's account, so it carries Kage's footer like every other post from there.
      const r = await user.chat.postMessage({ channel: dm, ...ownerPost(Title, safeReply(a.text).trim(), foot), unfurl_links: false })
      append('posted', [dm, r.ts!, 'people'])
      sentForPeople.set(`${dm}:${r.ts}`, foot)
      const link = await user.chat.getPermalink({ channel: dm, message_ts: r.ts! }).then(x => x.permalink ?? '').catch(() => '')
      return { text: `sent from the owner's account, marked ${Title}: ${link || dm} (channel ${dm}, ts ${r.ts}; pass these to edit_message or delete_message)` }
    },
  }, {
    name: 'send_file',
    description: 'Attach a file to the thread a task came from: a CSV for a table too long for a message or one the reader will keep or copy into a sheet, a PNG for a chart. Post the short answer with reply as well.',
    shape: {
      channel: s.describe('channel attribute from the task tag'),
      thread_ts: s.describe('thread_ts attribute from the task tag'),
      path: s.describe(`absolute path of a .csv or .png file you wrote in this thread's folder, ${o.dir}/files/<channel>_<thread_ts>/`),
    },
    async run(args) {
      const a = args as { channel: string; thread_ts: string; path: string }
      if (!taskChannels.has(a.channel)) return { isError: true, text: 'refused: no task came from that channel' }
      const folder = filesOf(a.channel, a.thread_ts)
      let real = ''
      try { real = realpathSync(a.path); if (!real.startsWith(`${realpathSync(folder)}/`) || !statSync(real).isFile()) real = '' } catch { real = '' }
      if (!real) return { isError: true, text: `refused: send only a file you wrote in this thread's files folder, ${folder}/` }
      const type = extname(real).toLowerCase()
      if (type !== '.csv' && type !== '.png') return { isError: true, text: 'refused: send a .csv (it opens in Excel and Google Sheets) or a .png' }
      // A file goes to the whole thread, so a secret in it is refused for everyone, owner included.
      const csv = type === '.csv' ? readFileSync(real, 'utf8') : ''
      const secret = findSecret(csv) || (/(^|,)\s*"?[^,\n]*(password|passwd|secret|token|api.?key)/i.test(csv.split('\n')[0]!) && 'password or key column')
      if (secret) return { isError: true, text: `refused: the file looks like it holds a ${secret}. Leave it out of the file.` }
      try {
        await bot.filesUploadV2({ channel_id: a.channel, thread_ts: a.thread_ts, file: real, filename: basename(real) })
      } catch (e: any) {
        const why = e?.data?.error
        if (why === 'missing_scope') return { isError: true, text: `not sent: ${Title} cannot attach files until the owner adds the files:write scope to the Slack app. Post the table in the thread instead.` }
        if (['not_in_channel', 'channel_not_found'].includes(why)) return { isError: true, text: `not sent: ${Title} is not a member of this conversation, so it cannot attach files here. Post the table in the thread instead.` }
        throw e
      }
      return { text: `attached ${basename(a.path)} to the thread` }
    },
  }, {
    name: 'delete_message',
    description: `Delete a message ${Title} posted (channel and ts come from the reply result). Only when it should not be there at all.`,
    shape: { channel: s, ts: s },
    run: args => change({ channel: String(args.channel), ts: String(args.ts) }, false),
  }, {
    name: 'waiting',
    description: 'List every open question or offer, across all threads, that still waits on an answer.',
    shape: {},
    async run() {
      const open = openWaiting(ledger('waiting'))
      return { text: open.length ? open.map(i => `${i.when} ${i.link} ${i.what}`).join('\n') : 'nothing is waiting' }
    },
  }, {
    name: 'log_prod_write',
    description: 'Record one change made to production for this task (deploy, restart, DB write, prod config). Call it once per change, right after it.',
    shape: {
      channel: s.describe('channel attribute from the task tag'),
      thread_ts: s.describe('thread_ts attribute from the task tag'),
      what: s.describe('what changed, in plain words'),
      command: s.describe('the command or query that changed it, with secrets removed'),
      result: s.describe('the outcome, with the proof'),
    },
    async run(args) {
      const p = args as { channel: string; thread_ts: string; what: string; command: string; result: string }
      const key = `${p.channel}:${p.thread_ts}`
      const job = c.job()   // a job run's prod write is one of that job's acts (ADR 0017)
      append('prod-actions', [ownerTask.get(key) ? 'owner' : 'teammate', links.get(key) ?? key, p.what, p.command, p.result, ...job ? [job] : []])
      return { text: 'logged to the prod-actions ledger' }
    },
  }]
  // The owner's own task may have Kage post where no task came from (a channel it just made, an announcement),
  // so no session needs the bot token itself. Bot only: never the owner's account, never a kagelet.
  if (!name && !o.dreaming) tools.push({
    name: 'post_as_kage',
    description: `Post as ${Title} in a channel the owner names, when their own task asks for it: a channel ${Title} made or works in, top level or in a thread there. For the task's own thread use reply.`,
    shape: {
      channel: s.describe('channel attribute from the task tag'),
      thread_ts: s.describe('thread_ts attribute from the task tag'),
      to: s.describe('the channel id (C...) to post in'),
      to_thread_ts: s.optional().describe('a thread in that channel to post in; leave out for a top-level post'),
      text: s.describe('Slack mrkdwn text'),
    },
    async run(args) {
      const a = args as { channel: string; thread_ts: string; to: string; to_thread_ts?: string; text: string }
      // An agent may post with the owner's token, and an owner-verified call still has anyone listening in: neither counts.
      if (!ownerOnly(a) || a.channel === 'voice' || agents.get(`${a.channel}:${a.thread_ts}`)) return { isError: true, text: "refused: only the owner's own task may post where no task came from" }
      if (!/^[CG][A-Z0-9]+$/.test(a.to)) return { isError: true, text: 'refused: name the channel by its id (C...)' }
      if (!a.text.trim()) return { isError: true, text: 'refused: the text is empty' }
      const no = secretRefusal(a.text, { fromOwner: true }) ?? layoutRefusal(a.text)
      if (no) return { isError: true, text: no }
      const sent: string[] = []
      try {
        for (const part of splitForSlack(safeReply(a.text).trim())) {
          const r = await bot.chat.postMessage({ channel: a.to, thread_ts: a.to_thread_ts, text: part, unfurl_links: false })
          append('posted', [a.to, r.ts!, 'bot', `${a.channel}:${a.thread_ts}`])
          sent.push(r.ts!)
        }
      } catch (e: any) {
        if (['not_in_channel', 'channel_not_found'].includes(e?.data?.error)) return { isError: true, text: `not sent: ${Title} is not a member of ${a.to}. Ask the owner to /invite @${Title.toLowerCase()} there.` }
        throw e
      }
      return { text: `posted as ${Title} in channel ${a.to}, ts ${sent.join(', ')}` }
    },
  })
  return tools
}
