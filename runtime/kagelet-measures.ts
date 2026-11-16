// The hub's measure of each kagelet's objective (ADR 0016): run with no model on its own clock, pinned like a probe,
// and the last readings kept for every run to read. A measure Kage wrote runs only after the owner's yes on that exact
// command; one in a file the owner wrote is theirs already. The value goes to the run, never to the event log.
import { meets, readValue, scoreboard, type Objective, type Reading } from '../core/objective.ts'
import { pinsChanged, type Probe } from '../core/tripwire.ts'
import { buildProbe, tripwireCfg, type TripwireSettings } from './probe-jobs.ts'
import { pin, runProbe } from './probes.ts'
import type { Store } from './store.ts'

const READINGS = 'kagelet-readings'
const APPROVED = 'kagelet-measures'
type Measured = { name: string; by: 'owner' | 'kage'; paused: boolean; objective?: Objective }

export function kageletMeasures(o: {
  store: Pick<Store, 'load' | 'save'>
  settings: () => { measureMinutes: number; trendRuns: number }
  tripwires: () => TripwireSettings
  event: (who: string, detail: string) => void
}) {
  const readings = () => (o.store.load(READINGS) ?? {}) as Record<string, { measure: string; list: Reading[] }>
  // The readings of this measure only: a new command starts a new trend.
  const trend = (name: string, measure?: string) => { const r = readings()[name]; return r && (measure === undefined || r.measure === measure) ? r.list : [] }
  const approved = () => (o.store.load(APPROVED) ?? {}) as Record<string, Probe>
  const running = new Set<string>()   // a measure may take up to the probe timeout, longer than one tick
  const forgotten = new Map<string, number>()   // bumped by forget, so a measure still running when its kagelet goes saves nothing
  // The owner's yes on a measure: the command pinned as it is now. Returns why it was refused.
  function approve(name: string, command: string): string | undefined {
    const p = buildProbe({ command }, tripwireCfg(o.tripwires()).patternMax)
    if (typeof p === 'string') return p
    o.store.save(APPROVED, { ...approved(), [name]: p })
  }
  async function measure(k: Measured & { objective: Objective }, now: number): Promise<Reading> {
    // The owner's own file needs no card, but it is pinned on its first run too, so a kagelet's shell cannot swap the script.
    if (k.by === 'owner' && approved()[k.name]?.command !== k.objective.measure) { const why = approve(k.name, k.objective.measure); if (why) return { at: now, failed: why } }
    const p = approved()[k.name]
    if (p?.command !== k.objective.measure) return { at: now, failed: 'the owner has not approved this measure' }
    const c = tripwireCfg(o.tripwires())
    const run = await runProbe(p, { timeoutMs: c.timeoutSec * 1000, maxBytes: c.maxKb * 1024, patternMax: c.patternMax, lineMax: c.lineMax, env: c.env })
    const value = run.ok ? readValue(run.out) : undefined
    return value === undefined ? { at: now, failed: run.refused ?? run.why ?? 'it printed no single "value: <n>" line' } : { at: now, value }
  }
  return {
    approve,
    // The command the owner said yes to, while its script is still the one they saw.
    approved: (name: string) => { const p = approved()[name]; return p && !pinsChanged(p.pins, pin(p.command)).length ? p.command : undefined },
    readings: (name: string) => trend(name),
    board: (name: string, objective: Objective | undefined) => objective && scoreboard(objective, trend(name, objective.measure)),
    // A removed kagelet: a new one by the same name starts with no yes and no trend.
    forget(name: string) {
      const { [name]: _r, ...r } = readings(), { [name]: _a, ...a } = approved()
      o.store.save(READINGS, r); o.store.save(APPROVED, a)
      forgotten.set(name, (forgotten.get(name) ?? 0) + 1)
    },
    // On the hub's clock: each running kagelet with an objective is measured once per measureMinutes.
    async tick(kagelets: Measured[], now: number) {
      const s = o.settings()
      for (const k of kagelets) {
        if (k.paused || !k.objective || running.has(k.name) || now - (trend(k.name, k.objective.measure).at(-1)?.at ?? -Infinity) < s.measureMinutes * 60_000) continue
        running.add(k.name)
        const era = forgotten.get(k.name)
        const r = await measure({ ...k, objective: k.objective }, now).finally(() => running.delete(k.name))
        if (forgotten.get(k.name) !== era) continue
        o.store.save(READINGS, { ...readings(), [k.name]: { measure: k.objective.measure, list: [...trend(k.name, k.objective.measure), r].slice(-s.trendRuns) } })
        o.event(k.name, r.value === undefined ? 'measure failed' : meets(r.value, k.objective.target) ? 'measure met' : 'measure working')
      }
    },
  }
}
