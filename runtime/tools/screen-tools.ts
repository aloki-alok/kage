import { z } from 'zod'
import { desktopVerdict, parseDesktopAct, sendsLine, type DesktopAct } from '../../core/desktop-act.ts'
import type { KageTool, ToolContext } from '../kage-tools.ts'

const MAX_SECONDS = 600
const CLEARS_LINE = new Set(['ctrl+c', 'ctrl+u'])

const command = (a: DesktopAct) => a.action === 'drag' ? { op: 'drag', x: a.x, y: a.y, toX: a.toX, toY: a.toY } : { op: a.action, ...a }

export function screenTools(c: ToolContext): KageTool[] {
  const { o, s, filesOf, ownerActs, name } = c
  const screen = o.screen
  if (!screen || name || o.dreaming) return []
  const where = { channel: s.describe('channel attribute from the task tag'), thread_ts: s.describe('thread_ts attribute from the task tag') }
  const app = s.optional().describe('only this app\'s windows, by name ("Google Chrome") or bundle id; leave it out for the whole main display')
  const refused = (args: Record<string, unknown>) => ownerActs(args) ? undefined : { isError: true as const, text: "refused: only the owner's own task sees their screen" }
  const seen = (tool: string, outcome: string) => o.event?.('tool', `${tool} ${outcome}`)
  const typed = new Map<string, string | undefined>()
  const fileFor = (args: Record<string, unknown>, ext: string) => `${filesOf(String(args.channel), String(args.thread_ts))}/screen-${Date.now()}.${ext}`
  return [{
    name: 'screen_act',
    description: "Act on the owner's Mac as a person would: click (count 2 for a double click, button right for a menu), move, drag, scroll, type text, or press keys (cmd+shift+g, return, down). x and y are pixels on the whole-screen picture screen_shot takes, so take one first, and again after each step that changes the screen. The owner sees Kage's own cursor make each step. Everyday steps run at once. A step that cannot be undone (Delete, Move to Trash, a one-way command in a terminal) waits for the owner's yes, and turning the Mac off, logging out, locking it or erasing it is refused. In a terminal, press ctrl+c first for a clean line, type one line, then press return. Any other key or a click there makes the line unknown, so its Return waits for the owner. Owner tasks only.",
    shape: {
      ...where,
      action: z.enum(['click', 'move', 'drag', 'scroll', 'type', 'key']),
      x: z.number().optional(), y: z.number().optional(), to_x: z.number().optional().describe('drag: where it ends'), to_y: z.number().optional(),
      button: z.enum(['left', 'right']).optional(), count: z.number().optional().describe('click: 2 for a double click'),
      dy: z.number().optional().describe('scroll: lines, negative is down'), dx: z.number().optional(),
      text: s.optional().describe('type: the text'), keys: s.optional().describe('key: one key and its modifiers, such as cmd+shift+g'),
    },
    async run(args) {
      const no = refused(args); if (no) return no
      const act = parseDesktopAct(args)
      if ('error' in act) return { isError: true, text: act.error }
      const looked = act.action === 'click' ? await screen.act({ op: 'under', x: act.x, y: act.y }) : act.action === 'key' || act.action === 'type' ? await screen.act({ op: 'focused' }) : {}
      if ('error' in looked) return { isError: true, text: String(looked.error) }
      const under = { app: String(looked.app ?? ''), role: String(looked.role ?? ''), label: String(looked.label ?? '') }
      const line = typed.get(under.app)
      const v = desktopVerdict(act, under, line)
      if ('blocked' in v) { seen('screen_act', `${act.action} refused`); return { isError: true, text: `refused: ${v.blocked}. This is never done on the owner's Mac.` } }
      if ('ask' in v) {
        if (!o.approve) return { isError: true, text: `refused: ${v.ask}, which needs the owner's yes, and this session cannot ask them` }
        if (!await o.approve('screen_act', `${v.ask}, on your Mac`, { ...act })) { seen('screen_act', `${act.action} owner said no`); return { isError: true, text: 'the owner said no, so nothing was done. Ask them what to do instead.' } }
      }
      typed.set(under.app, act.action === 'type' ? line === undefined ? undefined : line + act.text : act.action === 'key' && (sendsLine(act.keys) || CLEARS_LINE.has(act.keys)) ? '' : undefined)
      const r = await screen.act(command(act))
      seen('screen_act', 'error' in r ? `${act.action} failed` : `${act.action} ok`)
      return 'error' in r ? { isError: true, text: String(r.error) } : { text: 'done. Take a screen_shot to see the result.' }
    },
  }, {
    name: 'screen_shot',
    description: "Take a picture of the owner's Mac screen, or of one app's windows, as a PNG in this thread's files folder. Read it to see the screen, or send it with send_file. Owner tasks only.",
    shape: { ...where, app },
    async run(args) {
      const no = refused(args); if (no) return no
      const file = fileFor(args, 'png')
      const err = await screen.shot(file, args.app as string | undefined)
      seen('screen_shot', err ? 'failed' : 'ok')
      return err ? { isError: true, text: err } : { text: `saved ${file}` }
    },
  }, {
    name: 'screen_record',
    description: `Record the owner's Mac screen as an MP4, or only one app's windows. start begins it and returns at once, so you can work while it records (for example with browser_act); stop ends it and gives the file for send_file. It stops by itself after seconds (300 unless set, at most ${MAX_SECONDS}). One recording at a time. Owner tasks only.`,
    shape: { ...where, action: z.enum(['start', 'stop']), app, seconds: z.number().optional().describe(`start: the longest it may run, at most ${MAX_SECONDS}`) },
    async run(args) {
      const no = refused(args); if (no) return no
      if (args.action === 'stop') {
        const r = await screen.stop()
        seen('screen_record', 'error' in r ? 'stop failed' : 'stop ok')
        return 'error' in r ? { isError: true, text: r.error } : { text: `saved ${r.file} (${r.seconds} s). Send it with send_file.` }
      }
      const seconds = Math.max(1, Math.min(MAX_SECONDS, Math.round(Number(args.seconds) || 300)))
      const err = await screen.start(fileFor(args, 'mp4'), seconds, args.app as string | undefined)
      seen('screen_record', err ? 'start failed' : 'start ok')
      return err ? { isError: true, text: err } : { text: `recording, for at most ${seconds} s. Do the steps, then call screen_record with action stop.` }
    },
  }]
}
