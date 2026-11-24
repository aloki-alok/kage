import { oneLine } from './text.ts'
export type EventKind = 'run.start' | 'run.end' | 'tool' | 'handoff' | 'grant' | 'refusal' | 'revoke' | 'owner-note' | 'report' | 'cap-pause' | 'cost-flag' | 'config.live' | 'config.restart' | 'config.refused' | 'memory-proposal' | 'memory-decision' | 'day-summary' | 'triage' | 'tripwire' | 'objective' | 'crash' | 'limit' | 'plan' | 'boot' | 'error' | 'shape' | 'held' | 'people-ask' | 'doctor'
export type KageEvent = { at: string; kind: EventKind; who: string; trace: string; chain: string; detail: string; transcript: string }

export const EVENT_DAYS = 30

export const eventRow = (e: Omit<KageEvent, 'at' | 'chain' | 'transcript'> & Partial<Pick<KageEvent, 'chain' | 'transcript'>>): Omit<KageEvent, 'at'> =>
  ({ chain: '', transcript: '', ...e, detail: oneLine(e.detail).slice(0, 200) })

export const tripwireDetail = (action: string, f: Record<string, string | number>) => `${action} ${Object.entries(f).map(([k, v]) => `${k}=${v}`).join(' ')}`

export const whoOf = (key: string) => key.split('#side-kagelet-')[1] ?? key

export const handoffDetail = (to: string, kind: string, failed?: string) => `to ${to}, ${kind}: ${failed ? `failed, ${failed}` : 'ok'}`
type ChainView = { chain: string; steps: string[]; state: string }
export function chainViews(events: KageEvent[]): ChainView[] {
  const chains = new Map<string, ChainView & { ended: Set<string> }>()
  for (const e of [...events].sort((a, b) => a.at.localeCompare(b.at))) {
    if (!e.chain || (e.kind !== 'handoff' && e.kind !== 'run.end')) continue
    const c = chains.get(e.chain) ?? chains.set(e.chain, { chain: e.chain, steps: [e.who], state: '', ended: new Set() }).get(e.chain)!
    if (e.kind === 'run.end') { c.ended.add(e.who); continue }
    const to = /^to (\S+), \w+: (ok|failed, (.*))$/.exec(e.detail)
    if (to) c.steps.push(to[1]!)
    if (to && to[2] !== 'ok') c.state = `stopped before ${to[1]}: ${to[3]}`
    else if (e.detail.startsWith('stopped: ')) c.state = `stopped at ${e.who}: ${e.detail.slice(9)}`
  }
  return [...chains.values()].map(({ ended, ...c }) => ({ ...c, state: c.state || (ended.has(c.steps.at(-1)!) ? 'done' : 'running') }))
}
export const chainLine = (c: ChainView) => `${c.steps.join(' > ')}  ${c.state}`
