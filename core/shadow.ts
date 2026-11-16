// Self-swap (ADR 0017): the hub grades a twin against the job it shadows. Pure: the ledger rows are the caller's.
// The model only says what it would do. A twin that never woke wrote no verdict, which counts as "would stay quiet".

// Where a twin's link lives: its job_state.shadow. live: the prompt it runs once it swaps in. since: when it was made.
// told: misses already told to the owner, so each is told once.
export type Shadow = { of: string; live: string; since: number; told?: number }
// act: a run of a job posted into its own thread or logged a prod write. verdict: a twin's run said it would act, or not.
export type Act = { job: string; at: number }
export type Verdict = { job: string; at: number; act: boolean }
type Miss = { at: number; kind: 'missed' | 'false-alarm' }
type Grade = { matches: number; misses: Miss[] }

// Pairs the old job's acts with the twin's "would act" verdicts. Acts closer than the window count as one run's.
// Quiet on both sides proves nothing, so it never counts. An act or verdict still inside its window waits.
export function grade(o: { twin: string; of: string; since: number; acts: Act[]; verdicts: Verdict[]; now: number; windowMs: number }): Grade {
  const w = o.windowMs
  const events: number[] = []
  for (const at of o.acts.filter(a => a.job === o.of && a.at >= o.since).map(a => a.at).sort((a, b) => a - b))
    if (!events.length || at - events[events.length - 1]! > w) events.push(at)
  const says = o.verdicts.filter(v => v.job === o.twin && v.act && v.at >= o.since).map(v => v.at)
  const near = (a: number, b: number) => Math.abs(a - b) <= w
  const g: Grade = { matches: 0, misses: [] }
  for (const t of events) {
    if (says.some(s => near(s, t))) g.matches++
    else if (o.now - t > w) g.misses.push({ at: t, kind: 'missed' })
  }
  for (const s of says) if (!events.some(t => near(s, t)) && o.now - s > w) g.misses.push({ at: s, kind: 'false-alarm' })
  return g
}

export const swapDue = (g: Grade, swapAfter: number) => g.misses.length === 0 && g.matches >= swapAfter
