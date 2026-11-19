import { liveTools, needsChanges } from '../core/job-needs.ts'
import type { Job } from './jobs.ts'
import type { Store } from './store.ts'

type Servers = Parameters<typeof liveTools>[0]
type StatusQuery = { initializationResult(): Promise<unknown>; mcpServerStatus(): Promise<Servers> }

export async function mcpStatus(q: StatusQuery, pollMs = 1000, tries = 20): Promise<Servers> {
  await q.initializationResult()
  let servers = await q.mcpServerStatus()
  for (let i = 1; i < tries && !liveTools(servers); i++) {
    await new Promise(r => setTimeout(r, pollMs))
    servers = await q.mcpServerStatus()
  }
  return servers
}

export const sdkLook = (query: (a: { prompt: AsyncIterable<never>; options: object }) => StatusQuery, options: object) => async () => {
  const ac = new AbortController()
  const prompt = (async function* () { await new Promise(r => ac.signal.addEventListener('abort', r)) })() as AsyncIterable<never>
  try { return await mcpStatus(query({ prompt, options: { ...options, abortController: ac } })) } finally { ac.abort() }
}

export function needsWatch(o: {
  store: Pick<Store, 'schedules' | 'jobState' | 'setJobState'>
  placeOf: (key: string) => string
  notify: (text: string) => Promise<boolean>
  look?: () => Promise<Servers>
  minutes?: number
}) {
  const needing = () => o.store.schedules().filter(s => s.needs?.length)
  const check = async (servers: Servers) => {
    const tools = liveTools(servers)
    if (!tools) return
    const jobs = needing().map(s => ({ id: s.id, place: o.placeOf(s.key), needs: s.needs!, missing: o.store.jobState(s.id).missing }))
    for (const c of needsChanges(jobs, tools)) {
      if (c.dm && !(await o.notify(c.dm))) continue
      const { missing: _, ...rest } = o.store.jobState(c.id)
      o.store.setJobState(c.id, c.missing.length ? { ...rest, missing: c.missing } : rest)
    }
  }
  let queue = Promise.resolve()
  const seen = (servers: Servers) => (queue = queue.then(() => check(servers)))
  const look = o.look
  return {
    seen,
    watching: () => needing().length > 0,
    jobs: look ? [{ name: 'job tools', every: (o.minutes || 10) * 60_000, run: async () => { if (needing().length) await seen(await look()) } }] as Job[] : [],
  }
}
