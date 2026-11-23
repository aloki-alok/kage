export function repeats(windowMs: number) {
  let last = '', since = 0, skipped = 0
  return (line: string, now: number): string[] => {
    if (line === last && now - since <= windowMs) { skipped++; return [] }
    const out = skipped ? [`(last line repeated ${skipped} more time${skipped === 1 ? '' : 's'})`, line] : [line]
    last = line; since = now; skipped = 0
    return out
  }
}
