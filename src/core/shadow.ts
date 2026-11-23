
export type Shadow = { of: string; live: string; since: number; told?: string[]; gone?: true }
export type Act = { job: string; at: number }
export type Verdict = { job: string; at: number; act: boolean }
type Miss = { at: number; kind: 'missed' | 'false-alarm' }
type Grade = { matches: number; misses: Miss[] }

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
