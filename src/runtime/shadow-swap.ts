import { grade, swapDue, type Act, type Shadow, type Verdict } from '../core/shadow.ts'
import type { Schedule } from '../core/cron.ts'
import type { JobState } from '../core/tripwire.ts'
import type { Store } from './store.ts'
import { threadOfJobLane } from '../core/conversations.ts'

type ShadowSettings = { swapAfter?: number; shadowWindowMin?: number; swapUndoDays?: number }
type Saved = { job: Schedule; state: JobState; twin: string; twinPrompt: string; shadow: Shadow; at: number }
const DAY = 86_400_000

const rowsOf = (tsv: string, col: number) => tsv.split('\n').filter(Boolean).map(l => l.split('\t')).map(c => ({ at: Date.parse(c[0]!), c, job: c[col] ?? '' }))

type Options = {
  store: Pick<Store, 'schedules' | 'jobState' | 'setJobState' | 'setPrompt' | 'load' | 'save'>
  ledgers: { text(name: 'posted' | 'prod-actions' | 'verdicts', since?: string): string }
  settings: () => ShadowSettings
  ping: (key: string, text: string) => void
  owner: (text: string) => void
  event: (detail: string) => void
  remove: (id: string) => void
  restore: (s: Schedule) => void
}
type Cfg = { after: number; windowMs: number; undoDays: number }
type Seen = { acts: Act[]; verdicts: Verdict[] }

const saved = (o: Options) => (o.store.load('swapped-out') ?? {}) as Record<string, Saved>
const cfg = (o: Options): Cfg => { const s = o.settings(); return { after: s.swapAfter ?? 3, windowMs: (s.shadowWindowMin ?? 30) * 60_000, undoDays: s.swapUndoDays ?? 7 } }

function forget(o: Options, all: Schedule[], c: Cfg, now: number) {
  const kept = saved(o)
  for (const [old, x] of Object.entries(kept)) if (all.some(s => s.id === old) && !o.store.jobState(x.twin).shadow) o.remove(old)
  const fresh = Object.fromEntries(Object.entries(kept).filter(([, x]) => now - x.at < c.undoDays * DAY))
  if (Object.keys(fresh).length !== Object.keys(kept).length) o.store.save('swapped-out', fresh)
}

function seenSince(o: Options, since: string): Seen {
  const acts: Act[] = [...rowsOf(o.ledgers.text('posted', since), 5), ...rowsOf(o.ledgers.text('prod-actions', since), 6)].filter(r => r.job).map(r => ({ job: r.job, at: r.at }))
  const verdicts: Verdict[] = rowsOf(o.ledgers.text('verdicts', since), 1).map(r => ({ job: r.job, at: r.at, act: r.c[2] === 'act' }))
  return { acts, verdicts }
}

function swap(o: Options, tw: Schedule, old: Schedule, state: JobState, matches: number, c: Cfg, now: number) {
  const sh = state.shadow!
  o.store.save('swapped-out', { ...saved(o), [old.id]: { job: old, state: o.store.jobState(old.id), twin: tw.id, twinPrompt: tw.prompt, shadow: sh, at: now } })
  const { shadow: _, ...live } = state
  o.store.setPrompt(tw.id, sh.live)
  o.store.setJobState(tw.id, live)
  o.remove(old.id)
  o.event(`swap job=${tw.id} of=${old.id} matches=${matches}`)
  o.ping(tw.key, `Job ${tw.id} matched job ${old.id} on ${matches} real events with no miss, so it now runs live and ${old.id} is off. ${old.id} is kept for ${c.undoDays} days: tell me "undo the swap" to bring it back.`)
}

function judge(o: Options, tw: Schedule, all: Schedule[], seen: Seen, c: Cfg, now: number) {
  const state = o.store.jobState(tw.id)
  const sh = state.shadow!
  const old = all.find(s => s.id === sh.of)
  if (!old) {
    if (!sh.gone) { o.owner(`Twin ${tw.id} shadows job ${sh.of}, which is gone, so it can never swap in. Remove the twin, or make it a live job.`); o.store.setJobState(tw.id, { ...state, shadow: { ...sh, gone: true } }) }
    return
  }
  const g = grade({ twin: tw.id, of: sh.of, since: sh.since, acts: seen.acts, verdicts: seen.verdicts, now, windowMs: c.windowMs })
  const told = sh.told ?? []
  const untold = g.misses.filter(m => !told.includes(`${m.at}:${m.kind}`))
  for (const m of untold) {
    o.event(`shadow job=${tw.id} of=${sh.of} result=miss kind=${m.kind}`)
    o.owner(`Twin ${tw.id} ${m.kind === 'missed' ? 'missed' : 'raised a false alarm on'} an event of job ${sh.of} at ${new Date(m.at).toISOString()}, so it will not swap in. Both jobs keep running. Fix the twin and make it again, or remove it.`)
  }
  if (untold.length) o.store.setJobState(tw.id, { ...state, shadow: { ...sh, told: [...told, ...untold.map(m => `${m.at}:${m.kind}`)] } })
  if (!swapDue(g, c.after)) return
  swap(o, tw, old, state, g.matches, c, now)
}

function tick(o: Options, now: number) {
  const c = cfg(o)
  const all = o.store.schedules()
  forget(o, all, c, now)
  const twins = all.filter(s => o.store.jobState(s.id).shadow)
  if (!twins.length) return
  const since = new Date(Math.min(...twins.map(t => o.store.jobState(t.id).shadow!.since)) - c.windowMs).toISOString()
  const seen = seenSince(o, since)
  for (const tw of twins) judge(o, tw, all, seen, c, now)
}

function restore(o: Options, key: string, id: string, now: number): string | undefined {
  const x = saved(o)[id]
  if (!x) return `no swapped-out job ${id}: it was never swapped out, or its ${cfg(o).undoDays} days have passed`
  if (x.job.key !== threadOfJobLane(key)) return `job ${id} is not in this thread`
  if (o.store.schedules().some(s => s.id === x.twin)) {
    o.store.setPrompt(x.twin, x.twinPrompt)
    o.store.setJobState(x.twin, { ...o.store.jobState(x.twin), shadow: { of: x.shadow.of, live: x.shadow.live, since: now } })
  }
  o.restore(x.job)
  o.store.setJobState(id, x.state)
  const { [id]: _, ...rest } = saved(o)
  o.store.save('swapped-out', rest)
  o.event(`restore job=${id} twin=${x.twin}`)
}

export function shadowSwaps(o: Options) {
  return { tick: (now: number) => tick(o, now), restore: (key: string, id: string, now: number) => restore(o, key, id, now) }
}
