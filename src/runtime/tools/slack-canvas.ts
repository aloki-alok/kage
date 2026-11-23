import { secretRefusal } from '../../core/outbound.ts'
import type { KageTool, ToolContext } from '../kage-tools.ts'

function canvasError(e: any): { isError: true; text: string } {
  const why = e?.data?.error
  if (why === 'missing_scope') return { isError: true, text: 'not done: the Slack app lacks the canvases:write scope. The owner runs kage slack upgrade once. Post the board in the thread until then.' }
  if (['not_in_channel', 'channel_not_found'].includes(why)) return { isError: true, text: 'not done: the bot is not a member of this channel. Ask for /invite of the bot here.' }
  throw e
}

export function makeCanvasTool({ Title, s, bot, ownerTask, append }: ToolContext): KageTool {
  return {
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
  }
}

export function editCanvasTool({ Title, s, bot, ownerTask, ledger }: ToolContext): KageTool {
  return {
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
      const mine = ledger('posted').split('\n').some(l => { const [, channel, id, by, k] = l.split('\t'); return channel === a.channel && id === a.canvas_id && by === 'canvas' && k === key })
      if (!ownerTask.has(key) || !mine) return { isError: true, text: `refused: ${Title} did not make that canvas from this thread` }
      const no = secretRefusal(a.markdown, { fromOwner: false })
      if (no) return { isError: true, text: no }
      try {
        await bot.canvases.edit({ canvas_id: a.canvas_id, changes: [{ operation: 'replace', document_content: { type: 'markdown', markdown: a.markdown } }] })
        return { text: `canvas ${a.canvas_id} updated` }
      } catch (e: any) { return canvasError(e) }
    },
  }
}
