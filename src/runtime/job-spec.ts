import { randomBytes } from 'node:crypto'
import { EVENT, nextRun, parseCron, REPLY } from '../core/cron.ts'
import { hookTokenHash, tempPaths, type Trigger } from '../core/tripwire.ts'
import type { ProbeArg } from './probe-jobs.ts'
import type { NewJob } from './schedule-edits.ts'

type JobSpec = {
  cron?: string; prompt: string; recurring?: boolean; lane?: boolean; model?: string; needs?: string[]; probe?: ProbeArg
  on_channel?: { channel: string; match?: string; bots?: boolean }; hook?: boolean
}
type HookUrl = ((id: string) => string | undefined) | undefined

export function jobFromSpec(a: JobSpec, hookUrl: HookUrl, folder: string, extra: (string | undefined)[] = []): { job: NewJob; token?: string } | string {
  if (!a.cron && !a.on_channel && !a.hook) return 'give one of cron, on_channel or hook'
  if (+!!a.cron + +!!a.on_channel + +!!a.hook > 1) return 'a job has one trigger: cron, on_channel or hook'
  if (a.probe && !a.cron) return 'a probe needs a clock cron'
  if (a.hook && !hookUrl?.('<id>')) return 'webhook jobs are off: the owner sets tripwires.hookPort first'
  const token = a.hook ? randomBytes(24).toString('hex') : undefined
  const trigger: Trigger | undefined = a.on_channel
    ? { kind: 'channel', channel: a.on_channel.channel, bots: a.on_channel.bots !== false, ...(a.on_channel.match !== undefined && { match: a.on_channel.match }) }
    : token ? { kind: 'hook', tokenHash: hookTokenHash(token) } : undefined
  const cron = trigger ? EVENT : a.cron!
  if (cron !== REPLY && !trigger) try { parseCron(cron) } catch (e) { return (e as Error).message }
  if (!a.prompt.trim()) return 'the prompt is empty'
  const temp = tempPaths([a.prompt, a.probe?.command, ...extra].filter(Boolean).join('\n'))
  if (temp.length) return `refused: this job names ${temp.join(', ')}, a temp folder the OS clears on its own, so the job fails once the file is gone. Copy the file into this thread's files folder, ${folder}/, and name that path in the job instead.`
  const job: NewJob = {
    id: randomBytes(4).toString('hex'), cron, prompt: a.prompt, recurring: a.recurring !== false, ...(trigger && { trigger }), ...(a.lane !== undefined && { lane: a.lane }),
    ...(a.needs?.length && { needs: a.needs }), ...(a.model && { model: a.model }), ...(a.probe && { probe: a.probe }),
  }
  return { job, ...token && { token } }
}

export function jobSetLine(job: NewJob, token: string | undefined, hookUrl: HookUrl): string {
  const t = job.trigger
  if (t?.kind === 'channel') return `Kage schedule ${job.id} set, wakes on a post in channel ${t.channel}${t.match !== undefined ? ` matching ${t.match}` : ''}${t.bots ? ', bots included' : ''}. No model runs until a post matches.`
  if (token) return `Kage schedule ${job.id} set, wakes on a call to its webhook. Shown once, give both to whoever sends the calls:\nURL: ${hookUrl!(job.id)}\nToken: ${token}\nSend: POST with the header "Authorization: Bearer <token>".`
  if (job.cron === REPLY) return `Watching: job ${job.id} runs each time someone writes in this thread, for 7 days. Kept by Kage: it survives restarts.`
  const next = nextRun(job.cron, new Date(), 366 * 24 * 3600_000)
  return `Kage schedule ${job.id} set, ${job.recurring ? 'recurring' : 'one-shot'} (${job.cron}). Next run: ${next?.toLocaleString() ?? 'none within a year'}. Kept by Kage: it survives restarts and runs until unschedule.`
}
