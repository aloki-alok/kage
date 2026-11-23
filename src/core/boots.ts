const CAUSES = ['update', 'settings', 'restart', 'crash', 'unknown', 'first'] as const
type Cause = typeof CAUSES[number]
export type Starts = Record<Cause | 'unrecorded' | 'total', number> & { lastCrash?: string }

export function startsSince(text: string | undefined, sinceSec: number): Starts {
  const s: Starts = { total: 0, update: 0, settings: 0, restart: 0, crash: 0, unknown: 0, first: 0, unrecorded: 0 }
  for (const line of (text ?? '').split('\n')) {
    const [at, cause, ...rest] = line.trim().split(' ')
    if (!(Number(at) > sinceSec)) continue
    s.total++
    const c = CAUSES.find(x => x === cause)
    if (!c) { s.unrecorded++; continue }
    s[c]++
    if (c === 'crash') s.lastCrash = rest.join(' ')
  }
  return s
}

const n = (k: number, one: string, many = `${one}s`) => `${k} ${k === 1 ? one : many}`

export function startsLine(s: Starts): string {
  if (!s.total) return '0 starts in 24 h'
  const parts = [
    ...s.crash ? [n(s.crash, 'crash', 'crashes')] : [],
    ...s.unknown ? [`${s.unknown} unknown`] : [],
    ...s.update ? [n(s.update, 'update')] : [],
    ...s.restart ? [n(s.restart, 'restart')] : [],
    ...s.settings ? [n(s.settings, 'settings change')] : [],
    ...s.first ? ['the first start'] : [],
    ...s.unrecorded ? [`${s.unrecorded} from before Kage kept causes`] : [],
    ...s.crash ? [] : ['0 crashes'],
  ]
  return `${n(s.total, 'start')} in 24 h: ${parts.join(', ')}`
}
