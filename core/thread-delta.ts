export type ThreadMark = { id: string; ts: string }
export type SessionNow = { id: string; resumable: boolean }

const tsParts = (ts: string) => ts.split('.').map(Number) as [number, number?]
export const tsAfter = (a: string, b: string) => {
  const [as, af = 0] = tsParts(a), [bs, bf = 0] = tsParts(b)
  return as > bs || (as === bs && af > bf)
}

export const seenUpTo = (mark: ThreadMark | undefined, now: SessionNow | undefined) =>
  mark && now?.resumable && mark.id === now.id ? mark.ts : undefined

const KEEP_SECONDS = 30 * 86_400

export function markSeen(marks: Record<string, ThreadMark>, key: string, mark: ThreadMark): Record<string, ThreadMark> {
  const oldest = Number(tsParts(mark.ts)[0]) - KEEP_SECONDS
  const kept = Object.entries(marks).filter(([k, m]) => k !== key && !(tsParts(m.ts)[0] < oldest))
  return Object.fromEntries([...kept, [key, mark]])
}
