import { readFileSync, realpathSync, statSync } from 'node:fs'
import { basename, extname } from 'node:path'
import { z } from 'zod'
import { foreignAgentRefusal } from '../../core/agents.ts'
import { openWaiting } from '../../core/ledgers.ts'
import { findSecret, layoutRefusal, ownerPost, safeReply, secretRefusal, splitForSlack } from '../../core/outbound.ts'
import type { KageTool, ToolContext } from '../kage-tools.ts'

const MARKS = { ack: '', question: 'scroll', answer: 'dagger_knife', done: 'crossed_swords' } as const
const HUB_DOWN = 'not sent: Kage is restarting. Wait a few seconds and send it again.'
function canvasError(e: any): { isError: true; text: string } {
  const why = e?.data?.error
  if (why === 'missing_scope') return { isError: true, text: 'not done: the Slack app lacks the canvases:write scope. The owner runs kage slack upgrade once. Post the board in the thread until then.' }
  if (['not_in_channel', 'channel_not_found'].includes(why)) return { isError: true, text: 'not done: the bot is not a member of this channel. Ask for /invite of the bot here.' }
  throw e
}

export function slackTools(c: ToolContext): KageTool[] {
  const dmLinksHeld = new Set<string>()
  const dmLinkHeld = (text: string) => {
    const fresh = [...text.matchAll(/slack\.com\/archives\/(D[A-Z0-9]+)\/p\d+/g)].map(x => x[0]).filter(l => !dmLinksHeld.has(l))
    for (const l of fresh) dmLinksHeld.add(l)
    return fresh.length ? `not sent: ${fresh.join(', ')} links a private DM, and everyone in this thread would see it. Say the message went out, in one line, with no link and no summary of what it said. If the asker asked for the link, send the same message again and it goes.` : undefined
  }
  const { o, Title, bot, user, s, taskChannels, ownerTask, unanswered, askers, agents, sentForPeople, dmThread, links, react, post, change, nameMentions, names, append, ledger, filesOf, ownerNow, ownerOnly, ownerActs, pingIn, name } = c
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
      waiting_on: s.optional().describe('With waiting: whose answer the work waits on. "owner" only for a one-way step (a deploy, a prod or database write, a merge, money, a send, a delete), a product or business choice, or something only the owner knows. Inside a job the owner already approved, decide the step yourself. A teammate\'s own test, data or decision: their Slack id (U...), and the reply tags them; it stays off the owner\'s waiting list.'),
      wide: z.boolean().optional().describe('true only for a log or code where wrapped lines are fine. Never for a table.'),
      tag_agent: z.boolean().optional().describe('On a task another agent posted: true only when that agent must read this post (the answer to its ask, or a question to it). An agent hears only posts that tag it, so acks, progress and thanks stay untagged.'),
      mark: z.enum(['ack', 'question', 'answer', 'done']).optional().describe('What this reply is, shown as a reaction on the task message: ack ("On it", no reaction), question (you need their answer to go on), answer (a quick question answered), done (the task is finished). Leave it out only on the reply that finishes the task.'),
    },
    async run(args) {
      const a = args as { channel: string; thread_ts: string; text: string; private?: boolean; owner_asked?: boolean; waiting?: string; waiting_on?: string; mark?: keyof typeof MARKS; wide?: boolean; tag_agent?: boolean }
      const key = `${a.channel}:${a.thread_ts}`
      if (!a.private && !taskChannels.has(a.channel)) return { isError: true, text: 'refused: no task came from that channel; use private=true' }
      const refusal = secretRefusal(a.text, { private: a.private, ownerAsked: a.owner_asked, fromOwner: ownerNow(key) }) ?? foreignAgentRefusal(a.text, o.foreignAgents?.() ?? [], agents.get(key)?.tag) ?? (a.private ? undefined : c.unseenMention(a.text)) ?? (a.private || a.channel.startsWith('D') ? undefined : dmLinkHeld(a.text))
      if (refusal) return { isError: true, text: refusal }
      if (a.channel === 'voice') {
        if (a.private) return { isError: true, text: 'refused: a voice call has no private reply' }
        if (o.send({ type: 'voice', text: a.text }) === false) return { isError: true, text: HUB_DOWN }
        return { text: 'spoken to the caller' }
      }
      if ((a.channel === 'whatsapp' || a.channel === 'email') && !a.private) {
        if (o.send({ type: a.channel === 'email' ? 'mail' : 'wa', text: a.text }) === false) return { isError: true, text: HUB_DOWN }
        return { text: a.channel === 'email' ? 'sent by email' : 'handed to the guard: it goes out as the owner, or to their Slack DM if the guard holds it' }
      }
      const ask = a.waiting?.trim(), on = a.waiting_on?.trim()
      if (ask && on !== 'owner' && !/^[UW][A-Z0-9]{2,}$/.test(on ?? '')) return { isError: true, text: 'not sent: with waiting, set waiting_on to "owner" or the Slack id (U...) of the person who must answer' }
      if (ask && on !== 'owner' && a.private) return { isError: true, text: 'not sent: a teammate cannot see the owner\'s DM. Ask them in the thread, or set waiting_on to "owner"' }
      if (ask && on !== 'owner' && !a.text.includes(`<@${on}>`)) a.text = `<@${on}>${/^(```|\|)/.test(a.text) ? '\n' : ' '}${a.text}`
      const layout = layoutRefusal(a.text, a)
      if (layout) return { isError: true, text: layout }
      const { via, where: at } = a.private ? await post(key, o.botDm(), dmThread.get(key), a.text) : await post(key, a.channel, a.thread_ts, a.text, a.tag_agent ? { tag: agents.get(key)?.tag } : {}, a.mark === 'ack')
      const emoji = MARKS[a.mark ?? 'done']
      if (emoji) {
        for (const origin of unanswered.get(key) ?? []) react(origin.channel, origin.ts, emoji)
        if (a.mark !== 'question') unanswered.delete(key)
      }
      if (ask && on === 'owner' && !openWaiting(ledger('waiting')).some(i => i.thread === key && i.what.trim().toLowerCase() === ask.toLowerCase())) append('waiting', ['open', key, links.get(key) ?? key, ask])
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
      const fromPhone = a.channel === 'whatsapp' && ownerOnly(a)
      if (!taskChannels.has(a.channel) || a.channel === 'email' || (a.channel === 'whatsapp' && !fromPhone) || (a.channel === 'voice' && !ownerOnly(a))) return { isError: true, text: 'refused: only a task from a Slack thread or the owner\'s own call may message people' }
      const unseen = c.unseenMention(a.text, a.users)
      if (unseen) return { isError: true, text: unseen }
      const toAgent = foreignAgentRefusal([a.text, ...a.users.map(u => `<@${u}>`)].join(' '), o.foreignAgents?.() ?? [])
      if (toAgent) return { isError: true, text: toAgent }
      const asker = ownerNow(key) ? undefined : askers.get(key) ?? { id: '', name: 'A teammate' }
      const ids = [...a.users, ...a.from ? [a.from] : []]
      if (!a.users.length || ids.some(u => !/^[UW][A-Z0-9]+$/.test(u))) return { isError: true, text: 'refused: name 1 to 8 people by their Slack user id (U...)' }
      if (!asker && a.from) await nameMentions(`<@${a.from}>`)
      const signer = asker ?? (a.from ? { id: a.from, name: names[a.from] ?? a.from } : undefined)
      const people = [...new Set([...a.users, ...signer?.id ? [signer.id] : []])]
      if (people.length > 8) return { isError: true, text: 'refused: name 1 to 8 people by their Slack user id (U...)' }
      const refusal = secretRefusal(a.text, { fromOwner: !asker })
      if (refusal) return { isError: true, text: refusal }
      const layout = layoutRefusal(a.text)
      if (layout) return { isError: true, text: layout }
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
    name: 'make_canvas',
    description: `Make a Slack canvas as ${Title}, tabbed in the channel the task came from, for a board or record people keep open (a tracker, a list of issues). Post its link in the thread with reply. Change it later with edit_canvas.`,
    shape: {
      channel: s.describe('channel attribute from the task tag'),
      thread_ts: s.describe('thread_ts attribute from the task tag'),
      title: s.describe('the canvas title'),
      markdown: s.describe('the whole canvas, in markdown'),
    },
    async run(args) {
      const a = args as { channel: string; thread_ts: string; title: string; markdown: string }
      if (!ownerTask.has(`${a.channel}:${a.thread_ts}`)) return { isError: true, text: 'refused: no task came from that thread' }
      const no = secretRefusal(a.markdown, { fromOwner: false })
      if (no) return { isError: true, text: no }
      try {
        const r = await bot.canvases.create({ channel_id: a.channel, title: a.title, document_content: { type: 'markdown', markdown: a.markdown } })
        append('posted', [a.channel, r.canvas_id!, 'canvas', `${a.channel}:${a.thread_ts}`])
        const team = await bot.auth.test()
        return { text: `made canvas ${r.canvas_id} in ${a.channel}: ${team.url}docs/${team.team_id}/${r.canvas_id} (pass the id to edit_canvas)` }
      } catch (e: any) { return canvasError(e) }
    },
  }, {
    name: 'edit_canvas',
    description: `Replace the whole content of a canvas ${Title} made from this thread with make_canvas.`,
    shape: {
      channel: s.describe('channel attribute from the task tag'),
      thread_ts: s.describe('thread_ts attribute from the task tag'),
      canvas_id: s.describe('the id make_canvas gave'),
      markdown: s.describe('the whole new canvas, in markdown'),
    },
    async run(args) {
      const a = args as { channel: string; thread_ts: string; canvas_id: string; markdown: string }
      const key = `${a.channel}:${a.thread_ts}`
      const mine = ledger('posted').split('\n').some(l => { const [, c, id, by, k] = l.split('\t'); return c === a.channel && id === a.canvas_id && by === 'canvas' && k === key })
      if (!ownerTask.has(key) || !mine) return { isError: true, text: `refused: ${Title} did not make that canvas from this thread` }
      const no = secretRefusal(a.markdown, { fromOwner: false })
      if (no) return { isError: true, text: no }
      try {
        await bot.canvases.edit({ canvas_id: a.canvas_id, changes: [{ operation: 'replace', document_content: { type: 'markdown', markdown: a.markdown } }] })
        return { text: `canvas ${a.canvas_id} updated` }
      } catch (e: any) { return canvasError(e) }
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
      const job = c.job()
      append('prod-actions', [ownerNow(key) ? 'owner' : 'teammate', links.get(key) ?? key, p.what, p.command, p.result, ...job ? [job] : []])
      return { text: 'logged to the prod-actions ledger' }
    },
  }]
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
      if (!ownerActs(a)) return { isError: true, text: "refused: only the owner's own task may post where no task came from" }
      if (!/^[CG][A-Z0-9]+$/.test(a.to)) return { isError: true, text: 'refused: name the channel by its id (C...)' }
      if (!a.text.trim()) return { isError: true, text: 'refused: the text is empty' }
      const no = secretRefusal(a.text, { fromOwner: ownerOnly(a) }) ?? layoutRefusal(a.text) ?? foreignAgentRefusal(a.text, o.foreignAgents?.() ?? []) ?? c.unseenMention(a.text)
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
