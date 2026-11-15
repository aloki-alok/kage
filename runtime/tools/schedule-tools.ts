// A thread's schedules in the hub, and AFK mode on and off (owner tasks only).
import { randomBytes } from 'node:crypto'
import { z } from 'zod'
import { awayCommand } from '../../core/afk.ts'
import { nextRun, parseCron, REPLY } from '../../core/cron.ts'
import type { KageTool, ToolContext } from '../kage-tools.ts'

export function scheduleTools(c: ToolContext): KageTool[] {
  const { o, s, ownerOnly } = c
  const tools: KageTool[] = []
  // Schedules the hub keeps for this thread: they survive restarts and closed sessions, and end
  // only when cancelled. Each run arrives as a task with the trust of the task that set it up.
  const jobs = o.schedules
  if (jobs) tools.push({
    name: 'schedule',
    description: 'Run a prompt in this thread on a schedule (or once at a set time), or each time someone writes here. Use it instead of CronCreate: CronCreate jobs die when this session closes or Kage restarts, these do not. To wait for someone\'s message, use cron "@reply", never a minute cron: it runs only when a message arrives, and ends by itself after 7 days. A clock schedule runs until you cancel it with unschedule.',
    shape: {
      cron: s.describe('"@reply" to run on each new message here, or a 5-field cron in local time: minute hour day-of-month month day-of-week, e.g. "*/15 9-18 * * 1-5"'),
      prompt: s.describe('what to do on each run, complete on its own: name the thread, the check, and when to stay quiet'),
      recurring: z.boolean().optional().describe('false runs it once, at the next match. Default true'),
      lane: z.boolean().optional().describe('true runs each run in its own lane beside this thread, so it never replays this thread\'s history (it keeps its own); false runs it in this thread. Default: the install\'s setting, usually true. Ignored for @reply'),
    },
    async run(args) {
      const a = args as { cron: string; prompt: string; recurring?: boolean; lane?: boolean }
      if (a.cron !== REPLY) try { parseCron(a.cron) } catch (e) { return { isError: true, text: (e as Error).message } }
      if (!a.prompt.trim()) return { isError: true, text: 'the prompt is empty' }
      const id = randomBytes(4).toString('hex')
      const recurring = a.recurring !== false
      const no = await jobs.add({ id, cron: a.cron, prompt: a.prompt, recurring, ...(a.lane !== undefined && { lane: a.lane ? true as const : undefined }) })
      if (no) return { isError: true, text: no }
      if (a.cron === REPLY) return { text: `Watching: job ${id} runs each time someone writes in this thread, for 7 days. Kept by Kage: it survives restarts.` }
      const next = nextRun(a.cron, new Date(), 366 * 24 * 3600_000)
      return { text: `Kage schedule ${id} set, ${recurring ? 'recurring' : 'one-shot'} (${a.cron}). Next run: ${next?.toLocaleString() ?? 'none within a year'}. Kept by Kage: it survives restarts and runs until unschedule.` }
    },
  }, {
    name: 'unschedule',
    description: 'Cancel one of this thread\'s schedules by its id.',
    shape: { id: s },
    async run(args) {
      if (!jobs.list().some(j => j.id === args.id)) return { isError: true, text: `no schedule ${String(args.id)} in this thread` }
      jobs.remove(String(args.id))
      return { text: `cancelled ${String(args.id)}` }
    },
  }, {
    name: 'schedules',
    description: 'List this thread\'s schedules.',
    shape: {},
    async run() {
      const all = jobs.list()
      return { text: all.length ? all.map(j => `${j.id} ${j.cron}${j.recurring ? '' : ' (once)'} ${j.prompt.split('\n')[0]!.slice(0, 120)}`).join('\n') : 'no schedules in this thread' }
    },
  })
  // AFK mode lives in the hub (connectors/slack-afk.ts). Only the owner's own task may switch it.
  const afk = o.afk
  if (afk) tools.push({
    name: 'away',
    description: 'Turn AFK mode on when the owner says, in any words, that they are stepping away or want you to cover for them ("take over", "cover for me", "going to eat for an hour", "in a meeting till 4"). While on, Kage watches threads that mention the owner, stays quiet unless they are mentioned again or it is urgent, and phones them for a P0. Calling it again moves the end time. Owner tasks only. Post the result line to the owner with reply.',
    shape: {
      channel: s.describe('channel attribute from the task tag'),
      thread_ts: s.describe('thread_ts attribute from the task tag'),
      minutes: z.number().optional().describe('how long, if they said a length ("an hour" is 60)'),
      until: s.optional().describe('the end as a 24-hour time in their zone, like "16:00", if they said a clock time. Leave both out for the 12-hour default'),
      note: s.optional().describe('why they are away and anything they asked you to handle, in their words'),
    },
    async run(args) {
      if (!ownerOnly(args)) return { isError: true, text: 'only the owner can turn AFK mode on' }
      const c = awayCommand(args as { minutes?: number; until?: string; note?: string })
      return typeof c === 'string' ? { isError: true, text: c } : { text: await afk(c) }
    },
  }, {
    name: 'back',
    description: 'Turn AFK mode off when the owner says, in any words, that they are back. Returns the summary of who wanted what: post it to the owner with reply. Owner tasks only.',
    shape: { channel: s.describe('channel attribute from the task tag'), thread_ts: s.describe('thread_ts attribute from the task tag') },
    async run(args) {
      if (!ownerOnly(args)) return { isError: true, text: 'only the owner can turn AFK mode off' }
      return { text: await afk({ kind: 'back' }) }
    },
  })
  return tools
}
