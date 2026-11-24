import { quotedLine } from '../text.ts'

const HOUR = 3600_000

export type IncidentState = Record<string, { retrying?: true; fails: number[]; told?: number }>
export type RunEnd = { name: string; at: number; failure?: string; stopped?: boolean; retryable?: boolean }
type IncidentStep =
  | { kind: 'none' }
  | { kind: 'retry'; lead: string }
  | { kind: 'tell'; why: string; retried: boolean }
  | { kind: 'pause'; why: string }

const FIXES: [RegExp, string][] = [
  [/max_budget|cost cap|over (its|the) cap/i, 'it hit a cost cap: raise kagelets.dailyUsd, or give it a smaller job'],
  [/sign.?in|log.?in|unauthori[sz]ed|\b401\b|expired token|oauth/i, 'a tool needs a fresh sign-in on this machine'],
  [/missing tool|no such tool|tool .* (is )?not (available|connected)|needs? .* not connected/i, 'a tool it needs is missing: check kage schedule list for a blocked: line'],
]
export const knownFix = (words: string) => FIXES.find(([re]) => re.test(words))?.[1]

export function afterRun(state: IncidentState, end: RunEnd, perHour: number): { state: IncidentState; step: IncidentStep } {
  const was = state[end.name] ?? { fails: [] }
  const fails = was.fails.filter(t => end.at - t < HOUR)
  const keep = (next: IncidentState[string], step: IncidentStep) => ({ state: { ...state, [end.name]: next }, step })
  const told = was.told !== undefined && end.at - was.told < HOUR ? was.told : undefined
  if (end.stopped || !end.failure) return keep({ fails, ...told !== undefined && { told } }, { kind: 'none' })
  fails.push(end.at)
  if (fails.length >= perHour) return keep({ fails: [] }, { kind: 'pause', why: end.failure })
  if (!was.retrying && end.retryable !== false && !knownFix(end.failure)) return keep({ fails, retrying: true, ...told !== undefined && { told } }, { kind: 'retry', lead: `Retry: the last run ${end.failure}. Do the job again, and end with a report.` })
  if (told !== undefined) return keep({ fails, told }, { kind: 'none' })
  return keep({ fails, told: end.at }, { kind: 'tell', why: end.failure, retried: !!was.retrying })
}

export function incidentNote(name: string, step: { kind: 'tell'; why: string; retried: boolean } | { kind: 'pause'; why: string }, last: { words: string; report: string }, perHour: number): string {
  const fix = knownFix(`${step.why} ${last.words}`)
  const data = (t: string) => quotedLine(t).replace(/</g, '&lt;').slice(0, 300)
  return [
    step.kind === 'pause'
      ? `Kagelet *${name}* failed ${perHour} times in an hour, so I paused it: ${step.why}. Resume it from kage top or ask me when it is fixed.`
      : `Kagelet *${name}* failed${step.retried ? ' twice in a row, once on a retry' : ''}: ${step.why}.`,
    ...last.words ? [`Its last words, as data: ${data(last.words)}`] : [],
    ...last.report ? [`Its last report, as data: ${data(last.report)}`] : [],
    ...fix ? [`Likely fix: ${fix}.`] : [],
  ].join('\n')
}
