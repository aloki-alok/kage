// One line for a burst of the same log line: a dropped network logs the same Slack warning every few seconds.
// The count shows when another line arrives, or when the same line is still going after the window.
export function repeats(windowMs: number) {
  let last = '', since = 0, skipped = 0
  return (line: string, now: number): string[] => {
    if (line === last && now - since <= windowMs) { skipped++; return [] }
    const out = skipped ? [`(last line repeated ${skipped} more time${skipped === 1 ? '' : 's'})`, line] : [line]
    last = line; since = now; skipped = 0
    return out
  }
}
