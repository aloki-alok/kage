// Self-swap (ADR 0017): on the hub's clock, grade each twin against the job it shadows from the ledgers (core/shadow.ts),
// tell the owner once per miss, and swap a proven twin in. The old job is kept for swapUndoDays so the owner can restore it.
import { grade, swapDue, type Act, type Shadow, type Verdict } from '../core/shadow.ts'
import type { Schedule } from '../core/cron.ts'
import type { JobState } from '../core/tripwire.ts'
import type { Store } from './store.ts'
import { threadOfJobLane } from '../core/conversations.ts'

export type ShadowSettings = { swapAfter?: number; shadowWindowMin?: number; swapUndoDays?: number }
type Saved = { job: Schedule; state: JobState; twin: string; twinPrompt: string; shadow: Shadow; at: number }
const DAY = 86_400_000

// Rows are TSV with the time first (runtime/ledger.ts). col: where the job id sits, absent on rows that are not a job's act.
const rowsOf = (tsv: string, col: number) => tsv.split('\n').filter(Boolean).map(l => l.split('\t')).map(c => ({ at: Date.parse(c[0]!), c, job: c[col] ?? '' }))

export function shadowSwaps(o: {
  store: Pick<Store, 'schedules' | 'jobState' | 'setJobState' | 'setPrompt' | 'load' | 'save'>
  ledgers: { text(name: 'posted' | 'prod-actions' | 'verdicts', since?: string): string }
  settings: () => ShadowSettings
  ping: (key: string, text: string) => void     // into the job's thread as Kage
  owner: (text: string) => void                 // a DM to the owner
  event: (detail: string) => void               // one tripwire event row: ids and counts only (ADR 0010)
  remove: (id: string) => void                  // through the hub, so a channel watch goes with its job
  restore: (s: Schedule) => void                // the exact row back, and its watch
}) {
  const saved = () => (o.store.load('swapped-out') ?? {}) as Record<string, Saved>
  const cfg = () => { const s = o.settings(); return { after: s.swapAfter ?? 3, windowMs: (s.shadowWindowMin ?? 30) * 60_000, undoDays: s.swapUndoDays ?? 7 } }

  function tick(now: number) {
    const c = cfg()
    const all = o.store.schedules()
    const kept = saved()
    // A swap a crash cut short: the twin is live but the old job still runs. Finish it.
    for (const [old, x] of Object.entries(kept)) if (all.some(s => s.id === old) && !o.store.jobState(x.twin).shadow) o.remove(old)
    // The undo window has passed: the saved copy goes.
    const fresh = Object.fromEntries(Object.entries(kept).filter(([, x]) => now - x.at < c.undoDays * DAY))
    if (Object.keys(fresh).length !== Object.keys(kept).length) o.store.save('swapped-out', fresh)

    const twins = all.filter(s => o.store.jobState(s.id).shadow)
    if (!twins.length) return
    // A job's own-thread post (job id in cell 5) or prod write (cell 6) is one of its acts.
    // Only rows since the oldest twin was made, less one window (a twin may answer before the old job posts).
    const since = new Date(Math.min(...twins.map(t => o.store.jobState(t.id).shadow!.since)) - c.windowMs).toISOString()
    const acts: Act[] = [...rowsOf(o.ledgers.text('posted', since), 5), ...rowsOf(o.ledgers.text('prod-actions', since), 6)].filter(r => r.job).map(r => ({ job: r.job, at: r.at }))
    const verdicts: Verdict[] = rowsOf(o.ledgers.text('verdicts', since), 1).map(r => ({ job: r.job, at: r.at, act: r.c[2] === 'act' }))
    for (const tw of twins) {
      const state = o.store.jobState(tw.id)
      const sh = state.shadow!
      const old = all.find(s => s.id === sh.of)
      if (!old) {   // a person removed the old job: nothing left to prove against, so the owner decides, told once
        if (!sh.gone) { o.owner(`Twin ${tw.id} shadows job ${sh.of}, which is gone, so it can never swap in. Remove the twin, or make it a live job.`); o.store.setJobState(tw.id, { ...state, shadow: { ...sh, gone: true } }) }
        continue
      }
      const g = grade({ twin: tw.id, of: sh.of, since: sh.since, acts, verdicts, now, windowMs: c.windowMs })
      const told = sh.told ?? []
      const untold = g.misses.filter(m => !told.includes(`${m.at}:${m.kind}`))
      for (const m of untold) {
        o.event(`shadow job=${tw.id} of=${sh.of} result=miss kind=${m.kind}`)
        o.owner(`Twin ${tw.id} ${m.kind === 'missed' ? 'missed' : 'raised a false alarm on'} an event of job ${sh.of} at ${new Date(m.at).toISOString()}, so it will not swap in. Both jobs keep running. Fix the twin and make it again, or remove it.`)
      }
      if (untold.length) o.store.setJobState(tw.id, { ...state, shadow: { ...sh, told: [...told, ...untold.map(m => `${m.at}:${m.kind}`)] } })
      if (g.misses.length) continue
      if (!swapDue(g, c.after)) continue
      // Order (ADR 0017): save the old job, make the twin live, then remove the old job. A crash leaves two live jobs, never none.
      o.store.save('swapped-out', { ...saved(), [old.id]: { job: old, state: o.store.jobState(old.id), twin: tw.id, twinPrompt: tw.prompt, shadow: sh, at: now } })
      const { shadow: _, ...live } = state
      o.store.setPrompt(tw.id, sh.live)
      o.store.setJobState(tw.id, live)
      o.remove(old.id)
      o.event(`swap job=${tw.id} of=${old.id} matches=${g.matches}`)
      o.ping(tw.key, `Job ${tw.id} matched job ${old.id} on ${g.matches} real events with no miss, so it now runs live and ${old.id} is off. ${old.id} is kept for ${c.undoDays} days: tell me "undo the swap" to bring it back.`)
    }
  }

  // The owner's undo: the old job back as it was, and the twin a shadow again, its count restarted. Returns why not.
  function restore(key: string, id: string, now: number): string | undefined {
    const x = saved()[id]
    if (!x) return `no swapped-out job ${id}: it was never swapped out, or its ${cfg().undoDays} days have passed`
    if (x.job.key !== threadOfJobLane(key)) return `job ${id} is not in this thread`
    // Twin first: a crash before the old job is back leaves the copy saved and the twin a shadow, so a retry finishes it.
    if (o.store.schedules().some(s => s.id === x.twin)) {
      o.store.setPrompt(x.twin, x.twinPrompt)
      o.store.setJobState(x.twin, { ...o.store.jobState(x.twin), shadow: { of: x.shadow.of, live: x.shadow.live, since: now } })
    }
    o.restore(x.job)
    o.store.setJobState(id, x.state)
    const { [id]: _, ...rest } = saved()
    o.store.save('swapped-out', rest)
    o.event(`restore job=${id} twin=${x.twin}`)
  }

  return { tick, restore }
}
