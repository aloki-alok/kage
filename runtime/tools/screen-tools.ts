import { z } from 'zod'
import type { KageTool, ToolContext } from '../kage-tools.ts'

const MAX_SECONDS = 600

export function screenTools(c: ToolContext): KageTool[] {
  const { o, s, filesOf, ownerActs, name } = c
  const screen = o.screen
  if (!screen || name || o.dreaming) return []
  const where = { channel: s.describe('channel attribute from the task tag'), thread_ts: s.describe('thread_ts attribute from the task tag') }
  const app = s.optional().describe('only this app\'s windows, by name ("Google Chrome") or bundle id; leave it out for the whole main display')
  const refused = (args: Record<string, unknown>) => ownerActs(args) ? undefined : { isError: true as const, text: "refused: only the owner's own task sees their screen" }
  const seen = (tool: string, outcome: string) => o.event?.('tool', `${tool} ${outcome}`)
  const fileFor = (args: Record<string, unknown>, ext: string) => `${filesOf(String(args.channel), String(args.thread_ts))}/screen-${Date.now()}.${ext}`
  return [{
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
