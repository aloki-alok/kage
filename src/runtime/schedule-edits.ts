import { log } from './log.ts'
import { parseSessionKey, threadOfJobLane } from '../core/conversations.ts'
import { EVENT, nextRun, parseCron, REPLY, type Schedule } from '../core/cron.ts'
import { modelRefusal } from '../core/config.ts'
import { buildProbe, tripwireCfg, type ProbeArg, type TripwireSettings, type TuneArg } from './probe-jobs.ts'
import { safePattern, type Trigger } from '../core/tripwire.ts'
import { pin } from './probes.ts'
import type { Store } from './store.ts'

const PER_THREAD = 50
const DAY = 24 * 3600_000
const RUNS_WITHIN = 4 * 366 * DAY
export const WATCH_DAYS = 7

type Host = { store: Store; trusted: (key: string) => boolean; tripwires?: () => TripwireSettings; job: { laneDefault: () => boolean } }
export type NewJob = Pick<Schedule, 'id' | 'cron' | 'prompt' | 'recurring' | 'trigger' | 'needs' | 'model'> & { lane?: boolean; probe?: ProbeArg; shadow?: { of: string; live: string } }

export const listOf = (store: Store, key: string) => store.schedules().filter(s => s.key === threadOfJobLane(key))
const patternMaxOf = (o: Host) => tripwireCfg(o.tripwires?.() ?? {}).patternMax

function triggerOf(o: Host, j: NewJob, watch: boolean, event: boolean): Trigger | undefined | string {
  if (!j.probe) return j.trigger
  if (watch || event) return 'a probe needs a clock schedule, not @reply or an event'
  if (!j.recurring) return 'a probe job must recur: it only wakes on a change'
  const p = buildProbe(j.probe, patternMaxOf(o))
  if (typeof p === 'string') return p
  return { kind: 'probe', probe: p }
}

export function add(o: Host, from: string, j: NewJob, now: number): string | undefined {
  const { store } = o
  const key = threadOfJobLane(from)
  const watch = j.cron === REPLY, event = j.cron === EVENT
  if (!watch && !event) {
    try { parseCron(j.cron) } catch (e) { return (e as Error).message }
    if (!nextRun(j.cron, new Date(now), RUNS_WITHIN)) return `${j.cron} never runs`
  }
  const c = store.conversation(key)?.conversation
  if (c?.connector !== 'slack') return 'schedules work in Slack threads only'
  if (watch && c.agentDm) return 'a watch needs a thread other people write in; only you write in this DM'
  if (listOf(store, key).length >= PER_THREAD) return `this thread already has ${PER_THREAD} schedules`
  const lane = !watch && (event || (j.lane ?? o.job.laneDefault()))
  if (j.model) { const bad = modelRefusal(j.model) ?? (lane ? undefined : 'a job with its own model needs its own lane: drop lane false, or the model'); if (bad) return bad }
  const trigger = triggerOf(o, j, watch, event)
  if (typeof trigger === 'string') return trigger
  if (j.shadow) {
    const of = j.shadow.of
    if (!listOf(store, key).some(s => s.id === of)) return `no job ${of} in this thread to shadow`
    if (store.jobState(of).shadow) return `${of} is itself a twin: shadow the job it shadows`
  }
  const { probe: _, shadow, ...plain } = j
  store.addSchedule({ ...plain, ...(trigger && { trigger }), key, fromOwner: o.trusted(key), created: now, lastFired: 0, ...(lane ? { lane: true } : { lane: undefined }), ...(watch && { recurring: true, ends: now + WATCH_DAYS * DAY }), ...(event && { recurring: true }) })
  if (shadow) store.setJobState(j.id, { ...store.jobState(j.id), shadow: { of: shadow.of, live: shadow.live, since: now } })
  log('scheduled', j.id, j.cron, 'for', key)
}

export function adopt(store: Store, jobs: (Pick<Schedule, 'id' | 'key' | 'cron' | 'prompt' | 'recurring' | 'fromOwner' | 'created'>)[], ranUntil: number) {
  const adopted: string[] = [], skipped: string[] = []
  for (const j of jobs) {
    let ok = store.conversation(j.key)?.conversation.connector === 'slack'
    try { parseCron(j.cron) } catch { ok = false }
    if (!ok) { skipped.push(j.id); continue }
    const [, , dom, month] = j.cron.trim().split(/\s+/)
    const ends = dom !== '*' && month !== '*' ? { ends: j.created + 7 * DAY } : {}
    store.addSchedule(j.recurring ? { ...j, ...ends, lastFired: ranUntil } : { ...j, created: Math.max(j.created, ranUntil), lastFired: 0 })
    adopted.push(j.id)
  }
  return { adopted, skipped }
}

export function tune(o: Host, from: string, id: string, t: TuneArg, now: number): string | undefined {
  const { store } = o
  const s = store.schedules().find(x => x.id === id && x.key === threadOfJobLane(from))
  const { needs, ...probeChange } = t
  const setNeeds = () => { if (!needs) return; store.setNeeds(id, needs); const { missing: _, ...rest } = store.jobState(id); store.setJobState(id, rest) }
  if (!s) return `no ${needs && !Object.keys(probeChange).length ? '' : 'probe '}job ${id} in this thread`
  if (needs && !Object.keys(probeChange).length) { setNeeds(); return }
  if (s.trigger?.kind !== 'probe') return `${id} is not a probe job`
  const old = s.trigger.probe
  const cron = t.cron ?? s.cron
  try { parseCron(cron) } catch (e) { return (e as Error).message }
  if (!nextRun(cron, new Date(now), RUNS_WITHIN)) return `${cron} never runs`
  const patternMax = patternMaxOf(o)
  for (const r of t.ignore ?? []) { const why = safePattern(r, patternMax); if (why) return `ignore ${why}` }
  const command = t.command?.trim() ?? old.command
  if (!command) return 'the probe command is empty'
  const next = { command, ignore: t.ignore ?? old.ignore, reads: t.reads ?? old.reads, writes: t.writes ?? old.writes }
  const fresh = pin(command, next)
  const pins = t.command === undefined ? Object.fromEntries(Object.entries(fresh).map(([p, h]) => [p, old.pins[p] ?? h])) : fresh
  setNeeds()
  store.tuneSchedule(id, cron, { kind: 'probe', probe: { ...next, pins } }, t.command !== undefined || t.ignore !== undefined)
  log('tuned', id, 'for', s.key)
}

export function move(o: Host, from: string, id: string, to: string, now: number): string | undefined {
  const { store } = o
  const key = threadOfJobLane(from)
  if (!listOf(store, key).some(s => s.id === id)) return `no job ${id} in this thread`
  if (to === key) return `job ${id} is already in that thread`
  const c = store.conversation(to)?.conversation ?? parseSessionKey(to)?.conversation
  if (c?.connector !== 'slack') return 'jobs move to Slack threads only'
  if (c.agentDm || !c.thread || to.includes('#')) return 'give a Slack thread: a channel and a thread_ts'
  if (listOf(store, to).length >= PER_THREAD) return `that thread already has ${PER_THREAD} schedules`
  if (store.jobState(id).shadow || store.schedules().some(s => store.jobState(s.id).shadow?.of === id)) return `job ${id} is in a twin pair: end the twin first, then move the job`
  if (!store.conversation(to)) store.seen(to, c, store.conversation(key)?.conversation.chat === c.chat ? store.conversation(key)!.place : c.chat, now)
  store.moveSchedule(id, key, to, store.schedules().find(s => s.id === id)!.fromOwner && o.trusted(to))
  log('moved', id, 'from', key, 'to', to)
}
