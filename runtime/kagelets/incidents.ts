import { afterRun, incidentNote, type IncidentState } from '../../core/kagelets/incidents.ts'
import { whoOf } from '../../core/events.ts'
import type { Store } from '../store.ts'

const STATE = 'kagelet-incidents'
const STOP_KEPT = 10 * 60_000

export function kageletIncidents(o: {
  store: Pick<Store, 'load' | 'save'>
  perHour: () => number; stallMs: () => number
  retry: (name: string, lead: string, now: number) => void
  pause: (name: string, now: number) => void
  say: (text: string) => void
  last: (key: string, transcript: string) => { words: string; report: string }
  live: () => { key: string; busy: boolean; last: number }[]
  cut: (key: string) => void
}) {
  const stopped = new Map<string, number>()
  const stalled = new Map<string, number>()
  function ended(key: string, failure: string | undefined, transcript: string, now: number) {
    if (!key.includes('#side-kagelet-')) return
    const stop = stopped.get(key)
    stopped.delete(key)
    const name = whoOf(key), perHour = o.perHour()
    const r = afterRun((o.store.load(STATE) ?? {}) as IncidentState, { name, at: now, failure, stopped: stop !== undefined && now - stop < STOP_KEPT }, perHour)
    o.store.save(STATE, r.state)
    const step = r.step
    if (step.kind === 'retry') o.retry(name, step.lead, now)
    if (step.kind === 'pause') o.pause(name, now)
    if (step.kind === 'tell' || step.kind === 'pause') o.say(incidentNote(name, step, o.last(key, transcript), perHour))
  }
  return {
    stopped: (key: string, now: number) => { stopped.set(key, now) },
    ended(key: string, failure: string | undefined, transcript: string, now: number) {
      const cut = stalled.get(key)
      stalled.delete(key)
      if (cut !== undefined && now - cut < STOP_KEPT) return
      ended(key, failure, transcript, now)
    },
    stalls(now: number) {
      const ms = o.stallMs()
      for (const l of o.live()) {
        if (!l.busy || !l.key.includes('#side-kagelet-') || now - l.last < ms) continue
        stalled.set(l.key, now)
        o.cut(l.key)
        ended(l.key, `went quiet for ${Math.round(ms / 60_000)} min`, '', now)
      }
    },
  }
}
