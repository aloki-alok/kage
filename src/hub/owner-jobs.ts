import { z } from 'zod'
import { filesFolderName } from '../core/conversations.ts'
import { dueSchedules, type Schedule } from '../core/cron.ts'
import type { JobState } from '../core/tripwire.ts'
import { jobFromSpec, jobSetLine } from '../runtime/job-spec.ts'
import type { TuneArg } from '../runtime/probe-jobs.ts'
import type { NewJob } from '../runtime/schedule-edits.ts'
import type { Store } from '../runtime/store.ts'

const words = z.array(z.string())
const probe = z.object({ command: z.string(), ignore: words.optional(), reads: words.optional(), writes: words.optional() }).strict()
const spec = z.object({
  cron: z.string().optional(), prompt: z.string(), recurring: z.boolean().optional(), lane: z.boolean().optional(), model: z.string().optional(), needs: words.optional(),
  probe: probe.optional(), on_channel: z.object({ channel: z.string(), match: z.string().optional(), bots: z.boolean().optional() }).strict().optional(), hook: z.boolean().optional(),
}).strict()
const ask = z.discriminatedUnion('action', [
  z.object({ action: z.literal('add'), key: z.string(), spec }),
  z.object({ action: z.enum(['rm', 'pause', 'resume']), id: z.string() }),
  z.object({ action: z.literal('tune'), id: z.string(), change: probe.partial().extend({ cron: z.string().optional(), needs: words.optional() }).strict() }),
])

type Deps = {
  store: Store; dir: string
  jobs: { add(key: string, j: NewJob, now: number): string | undefined; remove(key: string, id: string): void; restore(s: Schedule): void; hookUrl(id: string): string | undefined }
  tune: (key: string, id: string, t: TuneArg, now: number) => string | undefined
}
type Paused = Record<string, { job: Schedule; state: JobState; at: number }>
type Answer = { text: string } | { refused: string }

export function ownerJobs(d: Deps) {
  const paused = () => (d.store.load('paused-jobs') ?? {}) as Paused
  const find = (id: string) => d.store.schedules().find(s => s.id === id)
  const folderOf = (key: string) => {
    const c = d.store.conversation(key)?.conversation
    return `${d.dir}/files/${c ? filesFolderName(c.chat, c.thread ?? '') : '<this thread>'}`
  }
  function add(key: string, s: z.infer<typeof spec>): Answer {
    const built = jobFromSpec(s, d.jobs.hookUrl, folderOf(key))
    if (typeof built === 'string') return { refused: built }
    const no = d.jobs.add(key, built.job, Date.now())
    return no ? { refused: no } : { text: jobSetLine(built.job, built.token, d.jobs.hookUrl) }
  }
  function pause(id: string): Answer {
    const s = find(id)
    if (!s) return { refused: `no job ${id} runs: kage schedule list shows them` }
    const twin = d.store.schedules().find(t => d.store.jobState(t.id).shadow?.of === id)
    if (twin) return { refused: `twin ${twin.id} shadows it: remove the twin first, or pause the twin instead` }
    d.store.save('paused-jobs', { ...paused(), [id]: { job: s, state: d.store.jobState(id), at: Date.now() } })
    d.jobs.remove(s.key, id)
    return { text: `Paused ${id}. It keeps its state, and kage schedule resume ${id} brings it back.` }
  }
  function resume(id: string): Answer {
    const { [id]: p, ...rest } = paused()
    if (!p) return { refused: `no paused job ${id}` }
    const now = Date.now()
    d.store.save('paused-jobs', rest)
    if (!p.job.recurring && dueSchedules([p.job], now).fire.length) return { text: `Removed ${id}: its time passed while it was paused.` }
    d.jobs.restore(p.job.recurring ? { ...p.job, lastFired: now } : { ...p.job, created: now })
    d.store.setJobState(id, p.state)
    return { text: `Resumed ${id}.` }
  }
  function rm(id: string): Answer {
    const { [id]: p, ...rest } = paused()
    if (p) { d.store.save('paused-jobs', rest); return { text: `Removed ${id}.` } }
    const s = find(id)
    if (!s) return { refused: `no job ${id}` }
    d.jobs.remove(s.key, id)
    return { text: `Removed ${id}.` }
  }
  return (m: unknown): Answer => {
    const r = ask.safeParse(m)
    if (!r.success) return { refused: `bad job request: ${r.error.issues.map(i => `${i.path.join('.') || 'action'} ${i.message}`).join(', ')}` }
    const a = r.data
    if (a.action === 'add') return add(a.key, a.spec)
    if (a.action !== 'tune') return { pause, resume, rm }[a.action](a.id)
    const s = find(a.id)
    if (!s) return { refused: `no job ${a.id} runs${paused()[a.id] ? ': resume it first' : ''}` }
    const no = d.tune(s.key, a.id, a.change, Date.now())
    return no ? { refused: no } : { text: `Tuned ${a.id}.` }
  }
}
