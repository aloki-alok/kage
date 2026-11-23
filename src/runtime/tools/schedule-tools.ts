import { randomBytes } from 'node:crypto'
import { z } from 'zod'
import { awayCommand } from '../../core/afk.ts'
import { EVENT, nextRun, parseCron, REPLY } from '../../core/cron.ts'
import { hookTokenHash, tempPaths, type Trigger } from '../../core/tripwire.ts'
import type { KageTool, Result, ToolContext } from '../kage-tools.ts'
import type { ProbeArg } from '../probe-jobs.ts'

type Jobs = NonNullable<ToolContext['o']['schedules']>
type Afk = NonNullable<ToolContext['o']['afk']>
type ScheduleArgs = { cron?: string; prompt: string; needs?: string[]; recurring?: boolean; lane?: boolean; probe?: ProbeArg; on_channel?: { channel: string; match?: string; bots?: boolean }; hook?: boolean; shadow_of?: string; live_prompt?: string }

export function scheduleTools(c: ToolContext): KageTool[] {
  return [...c.o.schedules ? jobTools(c, c.o.schedules) : [], ...c.o.afk ? awayTools(c, c.o.afk) : []]
}

function jobTools(c: ToolContext, jobs: Jobs): KageTool[] {
  return [
    scheduleTool(c, jobs), unscheduleTool(c, jobs), ...jobs.move ? [moveJobTool(c, jobs)] : [], shadowVerdictTool(c),
    ...jobs.restore ? [restoreJobTool(c, jobs)] : [], ...jobs.tune ? [tuneJobTool(c, jobs)] : [], schedulesTool(jobs),
  ]
}

function awayTools(c: ToolContext, afk: Afk): KageTool[] {
  return [awayTool(c, afk), backTool(c, afk)]
}

async function probeCard(c: ToolContext, description: string, input: Record<string, unknown>) {
  const { o } = c
  if (!o.approve) return 'refused: a probe from a teammate\'s task needs the owner\'s yes on a card, and this session cannot show one'
  return await o.approve('schedule', description, input) ? undefined : 'The owner said no. Nothing was scheduled.'
}

function tempRefusal(c: ToolContext, a: Record<string, unknown>, ...texts: (string | undefined)[]) {
  const { o } = c
  const found = tempPaths(texts.filter(Boolean).join('\n'))
  if (!found.length) return undefined
  const folder = a.channel && a.thread_ts ? c.filesOf(String(a.channel), String(a.thread_ts)) : `${o.dir}/files/<this thread>`
  return { isError: true as const, text: `refused: this job names ${found.join(', ')}, a temp folder the OS clears on its own, so the job fails once the file is gone. Copy the file into this thread's files folder, ${folder}/, and name that path instead.` }
}

function scheduleTool(c: ToolContext, jobs: Jobs): KageTool {
  const { s } = c
  return {
    name: 'schedule',
    description: 'Run a prompt in this thread on a schedule (or once at a set time), or each time someone writes here. Use it instead of CronCreate: CronCreate jobs die when this session closes or Kage restarts, these do not. To wait for someone\'s message, use cron "@reply", never a minute cron: it runs only when a message arrives, and ends by itself after 7 days. A clock schedule runs until you cancel it with unschedule.',
    shape: {
      cron: s.optional().describe('"@reply" to run on each new message here, or a 5-field cron in local time: minute hour day-of-month month day-of-week, e.g. "*/15 9-18 * * 1-5"'),
      prompt: s.describe('what to do on each run, complete on its own: name the thread, the check, and when to stay quiet'),
      recurring: z.boolean().optional().describe('false runs it once, at the next match. Default true'),
      on_channel: z.object({ channel: s.describe('the Slack channel id'), match: s.optional().describe('a regex a post must match'), bots: z.boolean().optional().describe('false ignores posts by bots and apps. Default true') }).optional().describe('instead of cron: wake this job on each matching post in a channel, with no model between posts. A burst becomes one run'),
      hook: z.boolean().optional().describe('instead of cron: give this job a webhook. The result holds its URL and token once: give both to whoever sends the calls. A teammate\'s ask needs the owner\'s yes on a card'),
      lane: z.boolean().optional().describe('true runs each run in its own lane beside this thread, so it never replays this thread\'s history (it keeps its own); false runs it in this thread. Default: the install\'s setting, usually true. Ignored for @reply'),
      probe: z.object({
        command: z.string().describe('a fixed shell command Kage runs on the clock with no model. The model wakes only when its output changes, so the prompt then says what to do about the change'),
        ignore: z.array(z.string()).optional().describe('regexes: a line that matches one is dropped before the output is compared (timestamps, counters)'),
        reads: z.array(z.string()).optional().describe('files the command reads as data, whose change is the point. They are not pinned'),
        writes: z.array(z.string()).optional().describe('files the command writes besides a redirect or tee. They are not pinned'),
      }).optional().describe('a clock schedule only. The command is pinned when set, with every script it names: an edited script stops the probe until a new yes. A teammate\'s probe needs the owner\'s yes on a card'),
      shadow_of: s.optional().describe('make this job a twin of that job id in this thread: it runs beside it and acts on nothing. Each run ends with shadow_verdict. The hub swaps it in by itself after enough real events where both agree, and stops for the owner on any miss (ADR 0017)'),
      live_prompt: s.optional().describe('with shadow_of: the prompt this twin runs once it swaps in and acts for real'),
      needs: z.array(z.string()).optional().describe('the MCP tools the job\'s action needs, by their full name (mcp__server__tool). Kage checks them on its clock with no model and tells the owner once when one is gone, before a run needs it'),
      channel: s.optional().describe('with probe: channel attribute from the task tag'),
      thread_ts: s.optional().describe('with probe: thread_ts attribute from the task tag'),
    },
    run: args => runSchedule(c, jobs, args),
  }
}

async function runSchedule(c: ToolContext, jobs: Jobs, args: Record<string, unknown>): Promise<Result> {
  const a = args as ScheduleArgs
  const refusal = scheduleRefusal(c, a, args)
  if (refusal) return { isError: true, text: refusal }
  const token = a.hook ? randomBytes(24).toString('hex') : undefined
  const url = a.hook ? jobs.hookUrl?.('<id>') : undefined
  if (a.hook && !url) return { isError: true, text: 'webhook jobs are off: the owner sets tripwires.hookPort first' }
  if ((a.hook || a.on_channel) && !c.o.approve) return { isError: true, text: 'webhook and channel jobs need the Agent SDK runner: this session cannot show the owner a card' }
  const trigger: Trigger | undefined = a.on_channel ? { kind: 'channel', channel: a.on_channel.channel, bots: a.on_channel.bots !== false, ...(a.on_channel.match !== undefined && { match: a.on_channel.match }) } : token ? { kind: 'hook', tokenHash: hookTokenHash(token) } : undefined
  const cron = trigger ? EVENT : a.cron!
  if (cron !== REPLY && !trigger) try { parseCron(cron) } catch (e) { return { isError: true, text: (e as Error).message } }
  if (!a.prompt.trim()) return { isError: true, text: 'the prompt is empty' }
  const temp = tempRefusal(c, args, a.prompt, a.live_prompt, a.probe?.command)
  if (temp) return temp
  const id = randomBytes(4).toString('hex')
  const recurring = a.recurring !== false
  if (a.probe && !c.ownerOnly(args)) {
    const why = await probeCard(c, `Run the command ${a.probe.command} on a clock (${cron}), as you, with no model, and wake a session when its output changes. Scripts it names are pinned.`, { cron, probe: a.probe })
    if (why) return { isError: true, text: why }
  }
  const no = await jobs.add({ id, cron, prompt: a.prompt, recurring, ...(trigger && { trigger }), ...(a.lane !== undefined && { lane: a.lane ? true as const : undefined }), ...(a.needs?.length && { needs: a.needs }), ...(a.probe && { probe: a.probe }), ...(a.shadow_of && { shadow: { of: a.shadow_of, live: a.live_prompt! } }) })
  if (no) return { isError: true, text: no }
  if (trigger?.kind === 'channel') return { text: `Kage schedule ${id} set, wakes on a post in channel ${trigger.channel}${trigger.match !== undefined ? ` matching ${trigger.match}` : ''}${trigger.bots ? ', bots included' : ''}. No model runs between posts. Kept by Kage: it survives restarts and runs until unschedule.` }
  if (token) return { text: `Kage schedule ${id} set, wakes on a call to its webhook. Shown once, give both to whoever sends the calls:\nURL: ${jobs.hookUrl!(id)}\nToken: ${token}\nSend: POST with the header "Authorization: Bearer <token>". The body reaches the job as data. Kept by Kage: it survives restarts and runs until unschedule.` }
  if (a.cron === REPLY) return { text: `Watching: job ${id} runs each time someone writes in this thread, for 7 days. Kept by Kage: it survives restarts.` }
  const next = nextRun(cron, new Date(), 366 * 24 * 3600_000)
  const poll = recurring && !a.probe && c.ownerOnly(args) && !c.jobRun()
    ? ' It runs a model on every run. If it only watches for a change, give it a probe. If each run does work (a draft, a review, research), make it a kagelet instead (kagelets skill) and unschedule this one.' : ''
  return { text: `Kage schedule ${id} set, ${recurring ? 'recurring' : 'one-shot'} (${cron}). Next run: ${next?.toLocaleString() ?? 'none within a year'}. Kept by Kage: it survives restarts and runs until unschedule.${poll}` }
}

function scheduleRefusal(c: ToolContext, a: ScheduleArgs, args: Record<string, unknown>) {
  if (!a.cron && !a.on_channel && !a.hook) return 'give one of cron, on_channel or hook'
  if (!a.shadow_of !== !a.live_prompt?.trim()) return 'a twin needs both shadow_of and live_prompt'
  if (a.shadow_of && c.jobRun()) return 'refused: a job\'s own run may not make a twin. Suggest it in your report.'
  if (a.shadow_of && !c.ownerOnly(args)) return 'only the owner\'s own task may make a twin: it removes the job it shadows by itself once proven'
  if (+!!a.cron + +!!a.on_channel + +!!a.hook > 1) return 'a job has one trigger: cron, on_channel or hook'
  if (a.probe && !a.cron) return 'a probe needs a clock cron'
  return undefined
}

function unscheduleTool(c: ToolContext, jobs: Jobs): KageTool {
  const { s } = c
  return {
    name: 'unschedule',
    description: 'Cancel one of this thread\'s schedules by its id.',
    shape: { id: s, channel: s.describe('channel attribute from the task tag'), thread_ts: s.describe('thread_ts attribute from the task tag') },
    async run(args) {
      if (c.jobRun()) return { isError: true, text: 'refused: a job\'s own run may not cancel a job. Put the change you suggest in your report: the owner or a teammate applies it.' }
      if (!jobs.list().some(j => j.id === args.id)) return { isError: true, text: `no schedule ${String(args.id)} in this thread` }
      jobs.remove(String(args.id))
      return { text: `cancelled ${String(args.id)}` }
    },
  }
}

function moveJobTool(c: ToolContext, jobs: Jobs): KageTool {
  const { s } = c
  return {
    name: 'move_job',
    description: 'Move one of this thread\'s jobs to another Slack thread, with the same id, clock and state. Use it when someone wants a job to post somewhere else (a fresh thread: post its first message with post_as_kage, then move the job there). Never write a script for this, and never ask anyone to run one. A job\'s own run may not call it. Another channel needs the owner\'s own task.',
    shape: {
      id: s.describe('the job id'), to_thread_ts: s.describe('ts of the first message of the target thread'),
      to_channel: s.optional().describe('the target channel id. Default: this thread\'s channel'),
      channel: s.describe('channel attribute from the task tag'), thread_ts: s.describe('thread_ts attribute from the task tag'),
    },
    async run(args: Record<string, unknown>) {
      if (c.jobRun()) return { isError: true, text: 'refused: a job\'s own run may not move a job. Put the move you suggest in your report.' }
      const job = jobs.list().find(j => j.id === String(args.id))
      if (!job) return { isError: true, text: `no job ${String(args.id)} in this thread` }
      const here = job.key.split(':')[0]!, to = String(args.to_channel ?? here), ts = String(args.to_thread_ts)
      if (to !== here && !c.ownerOnly(args)) return { isError: true, text: 'only the owner\'s own task may move a job to another channel. Ask the owner in this thread.' }
      const r = await c.user.conversations.replies({ channel: to, ts, limit: 1 }).catch(() => undefined)
      const first = r?.messages?.[0]
      if (!first || first.ts !== ts || (first.thread_ts && first.thread_ts !== ts)) return { isError: true, text: `no thread starts at ${ts} in ${to}: give the ts of its first message` }
      const no = jobs.move!(String(args.id), `${to}:${ts}`)
      return no ? { isError: true, text: no } : { text: `moved ${String(args.id)} to that thread. Its next run posts there.` }
    },
  }
}

function shadowVerdictTool(c: ToolContext): KageTool {
  const { s } = c
  return {
    name: 'shadow_verdict',
    description: 'A twin job\'s run ends with this (a job made with shadow_of): say whether the job it shadows should act on what this run saw. The hub, not you, compares it with what that job really did. Call it once per run, also when the answer is quiet.',
    shape: { act: z.boolean().describe('true: the shadowed job should act now (post, alert, change something). false: it should stay quiet'), what: s.describe('one line: what it should do, or why quiet') },
    async run(args) {
      const job = c.job()
      if (!job) return { isError: true, text: 'only a twin job\'s run may give a verdict' }
      c.append('verdicts', [job, args.act === true ? 'act' : 'quiet', String(args.what ?? '').replace(/\s+/g, ' ').slice(0, 200)])
      return { text: 'verdict recorded. The hub grades it against the shadowed job.' }
    },
  }
}

function restoreJobTool(c: ToolContext, jobs: Jobs): KageTool {
  const { s } = c
  return {
    name: 'restore_job',
    description: 'Undo a swap: when the owner says "undo the swap" (in any words) about a job a twin replaced, put the old job back by its id. The twin becomes a shadow again and its count restarts. Owner tasks only.',
    shape: { id: s.describe('the old job id named in the swap line'), channel: s.describe('channel attribute from the task tag'), thread_ts: s.describe('thread_ts attribute from the task tag') },
    async run(args: Record<string, unknown>) {
      if (!c.ownerOnly(args) || c.jobRun()) return { isError: true, text: 'only the owner\'s own task may undo a swap' }
      const no = jobs.restore!(String(args.id))
      return no ? { isError: true, text: no } : { text: `restored ${String(args.id)}; its twin is a shadow again` }
    },
  }
}

function tuneJobTool(c: ToolContext, jobs: Jobs): KageTool {
  const { s } = c
  return {
    name: 'tune_job',
    description: 'Change a job of this thread: the MCP tools it needs (any job), or a probe job\'s ignore regexes, reads, writes, command or cron. Only the owner\'s task may call it, or a teammate\'s task with the owner\'s yes on a card. A run woken by a job may never call it: it puts the change it suggests in its report. A new ignore or command restarts the job\'s baseline, so it wakes nothing by itself.',
    shape: {
      id: s.describe('the job id'), channel: s.describe('channel attribute from the task tag'), thread_ts: s.describe('thread_ts attribute from the task tag'),
      cron: s.optional(), command: s.optional(),
      ignore: z.array(z.string()).optional(), reads: z.array(z.string()).optional(), writes: z.array(z.string()).optional(),
      needs: z.array(z.string()).optional().describe('the full list of MCP tools the job needs; [] clears it'),
    },
    async run(args: Record<string, unknown>) {
      const { id, channel: _c, thread_ts: _t, ...change } = args as { id: string } & Record<string, unknown>
      if (c.jobRun()) return { isError: true, text: 'refused: a job\'s own run may not change its trigger. Put the change you suggest in your report: the owner or a teammate applies it.' }
      if (!Object.keys(change).length) return { isError: true, text: 'nothing to change: give needs, cron, command, ignore, reads or writes' }
      const temp = tempRefusal(c, args, typeof change.command === 'string' ? change.command : undefined)
      if (temp) return temp
      if (!c.ownerOnly(args)) {
        const why = await probeCard(c, `Change job ${id}: ${Object.entries(change).map(([k, v]) => `${k} to ${JSON.stringify(v)}`).join(', ')}. Kage runs the command on its clock, as you, with no model. A path in reads or writes is not pinned, so a script listed there can change with no new yes.`, { id, ...change })
        if (why) return { isError: true, text: why }
      }
      const no = jobs.tune!(id, change)
      return no ? { isError: true, text: no } : { text: `tuned ${id}` }
    },
  }
}

function schedulesTool(jobs: Jobs): KageTool {
  return {
    name: 'schedules',
    description: 'List this thread\'s schedules.',
    shape: {},
    async run() {
      const all = jobs.list()
      return { text: all.length ? all.map(j => `${j.id} ${j.cron}${j.recurring ? '' : ' (once)'} ${j.prompt.split('\n')[0]!.slice(0, 120)}`).join('\n') : 'no schedules in this thread' }
    },
  }
}

function awayTool(c: ToolContext, afk: Afk): KageTool {
  const { s } = c
  return {
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
      if (!c.ownerOnly(args)) return { isError: true, text: 'only the owner can turn AFK mode on' }
      const command = awayCommand(args as { minutes?: number; until?: string; note?: string })
      return typeof command === 'string' ? { isError: true, text: command } : { text: await afk(command) }
    },
  }
}

function backTool(c: ToolContext, afk: Afk): KageTool {
  const { s } = c
  return {
    name: 'back',
    description: 'Turn AFK mode off when the owner says, in any words, that they are back. Returns the summary of who wanted what: post it to the owner with reply. Owner tasks only.',
    shape: { channel: s.describe('channel attribute from the task tag'), thread_ts: s.describe('thread_ts attribute from the task tag') },
    async run(args) {
      if (!c.ownerOnly(args)) return { isError: true, text: 'only the owner can turn AFK mode off' }
      return { text: await afk({ kind: 'back' }) }
    },
  }
}
