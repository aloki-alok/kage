import { afterRun, incidentNote, type IncidentState } from '../../core/kagelets/incidents.ts'
import { whoOf } from '../../core/events.ts'
import type { Store } from '../store.ts'

const STATE = 'kagelet-incidents'
const isKagelet = (key: string) => key.includes('#side-kagelet-')

export function kageletIncidents(o: {
  store: Pick<Store, 'load' | 'save'>
  perHour: () => number; stallMs: () => number
  retryable: (name: string) => boolean
  retry: (name: string, lead: string, now: number) => void
  pause: (name: string, now: number) => void
  say: (text: string) => void
  last: (key: string, transcript: string) => { words: string; report: string }
  live: () => { key: string; busy: boolean; last: number; trace?: string }[]
  cut: (key: string) => void
}) {
  const stopped = new Set<string>()
  const cut = new Set<string>()
  function ended(key: string, failure: string | undefined, transcript: string, now: number, trace?: string) {
    if (!isKagelet(key)) return
    const name = whoOf(key), perHour = o.perHour()
    const was = trace !== undefined && stopped.delete(trace)
    const r = afterRun((o.store.load(STATE) ?? {}) as IncidentState, { name, at: now, failure, stopped: was, retryable: o.retryable(name) }, perHour)
    o.store.save(STATE, r.state)
    const step = r.step
    if (step.kind === 'retry') o.retry(name, step.lead, now)
    if (step.kind === 'pause') o.pause(name, now)
    if (step.kind === 'tell' || step.kind === 'pause') o.say(incidentNote(name, step, o.last(key, transcript), perHour))
  }
  return {
    stopped: (key: string, trace: string | undefined) => { if (isKagelet(key) && trace) stopped.add(trace) },
    ended(key: string, failure: string | undefined, transcript: string, now: number, trace?: string) {
      if (trace !== undefined && cut.delete(trace)) return
      ended(key, failure, transcript, now, trace)
    },
    stalls(now: number) {
      const ms = o.stallMs()
      for (const l of o.live()) {
        if (!l.busy || !isKagelet(l.key) || now - l.last < ms) continue
        if (l.trace) cut.add(l.trace)
        o.cut(l.key)
        ended(l.key, `went quiet for ${Math.round(ms / 60_000)} min`, '', now)
      }
    },
  }
}
