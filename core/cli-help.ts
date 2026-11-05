// Pure help for the kage command: the closest real command to a mistyped one.

const distance = (a: string, b: string) => {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const row = [i]
    for (let j = 1; j <= b.length; j++) row[j] = Math.min(prev[j]! + 1, row[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1))
    prev = row
  }
  return prev[b.length]!
}

// The one name the word starts, else the nearest name within 2 edits. A tie or a wide miss gives nothing.
export function suggest(word: string, names: string[]): string | undefined {
  const w = word.toLowerCase()
  const starts = names.filter(n => n.startsWith(w))
  if (w.length >= 3 && starts.length === 1) return starts[0]
  if (starts.length > 1) return undefined
  const scored = names.map(n => ({ n, d: distance(w, n) })).filter(s => s.d <= 2).sort((a, b) => a.d - b.d)
  if (!scored.length || (scored[1] && scored[1].d === scored[0]!.d)) return undefined
  return scored[0]!.n
}
