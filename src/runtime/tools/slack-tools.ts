import { readFileSync, realpathSync, statSync } from 'node:fs'
import { basename, extname } from 'node:path'
import { z } from 'zod'
import { foreignAgentRefusal } from '../../core/agents.ts'
import { openWaiting } from '../../core/ledgers.ts'
import { findSecret, layoutRefusal, safeReply, secretRefusal, splitForSlack } from '../../core/outbound.ts'
import type { KageTool, ToolContext } from '../kage-tools.ts'
import { editCanvasTool, makeCanvasTool } from './slack-canvas.ts'
import { messagePeopleTool } from './slack-people.ts'
import { replyTool } from './slack-reply.ts'

const NOT_MEMBER = ['not_in_channel', 'channel_not_found']

export function slackTools(c: ToolContext): KageTool[] {
  return [
    replyTool(c), editMessageTool(c), messagePeopleTool(c), sendFileTool(c), makeCanvasTool(c), editCanvasTool(c),
    deleteMessageTool(c), waitingTool(c), logProdWriteTool(c),
    ...!c.name && !c.o.dreaming ? [postAsKageTool(c)] : [],
  ]
}

function editMessageTool({ Title, s, change, pingIn }: ToolContext): KageTool {
  return {
    name: 'edit_message',
    description: `Change the text of a message ${Title} posted (channel and ts come from the reply result). Use it to fix a wrong or outdated reply.`,
    shape: { channel: s, ts: s, text: s.describe('the full new Slack mrkdwn text'), wide: z.boolean().optional().describe('as on reply') },
    run: args => change(args as { channel: string; ts: string; text: string; wide?: boolean }, pingIn(String(args.channel))),
  }
}

function sendFileTool(c: ToolContext): KageTool {
  const { Title, s, o } = c
  return {
    name: 'send_file',
    description: 'Attach a file to the thread a task came from: a CSV for a table too long for a message or one the reader will keep or copy into a sheet, a PNG for a chart. Post the short answer with reply as well.',
    shape: {
      channel: s.describe('channel attribute from the task tag'),
      thread_ts: s.describe('thread_ts attribute from the task tag'),
      path: s.describe(`absolute path of a .csv or .png file you wrote in this thread's folder, ${o.dir}/files/<channel>_<thread_ts>/`),
    },
    async run(args) {
      const a = args as { channel: string; thread_ts: string; path: string }
      if (!c.taskChannels.has(a.channel)) return { isError: true, text: 'refused: no task came from that channel' }
      const folder = c.filesOf(a.channel, a.thread_ts)
      const real = fileInFolder(a.path, folder)
      if (!real) return { isError: true, text: `refused: send only a file you wrote in this thread's files folder, ${folder}/` }
      const type = extname(real).toLowerCase()
      if (type !== '.csv' && type !== '.png') return { isError: true, text: 'refused: send a .csv (it opens in Excel and Google Sheets) or a .png' }
      const csv = type === '.csv' ? readFileSync(real, 'utf8') : ''
      const secret = findSecret(csv) || (/(^|,)\s*"?[^,\n]*(password|passwd|secret|token|api.?key)/i.test(csv.split('\n')[0]!) && 'password or key column')
      if (secret) return { isError: true, text: `refused: the file looks like it holds a ${secret}. Leave it out of the file.` }
      try {
        await c.bot.filesUploadV2({ channel_id: a.channel, thread_ts: a.thread_ts, file: real, filename: basename(real) })
      } catch (e: any) {
        const why = e?.data?.error
        if (why === 'missing_scope') return { isError: true, text: `not sent: ${Title} cannot attach files until the owner adds the files:write scope to the Slack app. Post the table in the thread instead.` }
        if (NOT_MEMBER.includes(why)) return { isError: true, text: `not sent: ${Title} is not a member of this conversation, so it cannot attach files here. Post the table in the thread instead.` }
        throw e
      }
      return { text: `attached ${basename(a.path)} to the thread` }
    },
  }
}

function fileInFolder(path: string, folder: string) {
  try {
    const real = realpathSync(path)
    return real.startsWith(`${realpathSync(folder)}/`) && statSync(real).isFile() ? real : ''
  } catch { return '' }
}

function deleteMessageTool({ Title, s, change }: ToolContext): KageTool {
  return {
    name: 'delete_message',
    description: `Delete a message ${Title} posted (channel and ts come from the reply result). Only when it should not be there at all.`,
    shape: { channel: s, ts: s },
    run: args => change({ channel: String(args.channel), ts: String(args.ts) }, false),
  }
}

function waitingTool({ ledger }: ToolContext): KageTool {
  return {
    name: 'waiting',
    description: 'List every open question or offer, across all threads, that still waits on an answer.',
    shape: {},
    async run() {
      const open = openWaiting(ledger('waiting'))
      return { text: open.length ? open.map(i => `${i.when} ${i.link} ${i.what}`).join('\n') : 'nothing is waiting' }
    },
  }
}

function logProdWriteTool(c: ToolContext): KageTool {
  const { s } = c
  return {
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
      c.append('prod-actions', [c.ownerNow(key) ? 'owner' : 'teammate', c.links.get(key) ?? key, p.what, p.command, p.result, ...job ? [job] : []])
      return { text: 'logged to the prod-actions ledger' }
    },
  }
}

function postAsKageTool(c: ToolContext): KageTool {
  const { Title, s } = c
  return {
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
      if (!c.ownerActs(a)) return { isError: true, text: "refused: only the owner's own task may post where no task came from" }
      if (!/^[CG][A-Z0-9]+$/.test(a.to)) return { isError: true, text: 'refused: name the channel by its id (C...)' }
      if (!a.text.trim()) return { isError: true, text: 'refused: the text is empty' }
      const no = secretRefusal(a.text, { fromOwner: c.ownerOnly(a) }) ?? layoutRefusal(a.text) ?? foreignAgentRefusal(a.text, c.o.foreignAgents?.() ?? []) ?? c.unseenMention(a.text)
      if (no) return { isError: true, text: no }
      const sent: string[] = []
      try {
        for (const part of splitForSlack(safeReply(a.text).trim())) {
          const r = await c.bot.chat.postMessage({ channel: a.to, thread_ts: a.to_thread_ts, text: part, unfurl_links: false })
          c.append('posted', [a.to, r.ts!, 'bot', `${a.channel}:${a.thread_ts}`])
          sent.push(r.ts!)
        }
      } catch (e: any) {
        if (NOT_MEMBER.includes(e?.data?.error)) return { isError: true, text: `not sent: ${Title} is not a member of ${a.to}. Ask the owner to /invite @${Title.toLowerCase()} there.` }
        throw e
      }
      return { text: `posted as ${Title} in channel ${a.to}, ts ${sent.join(', ')}` }
    },
  }
}
