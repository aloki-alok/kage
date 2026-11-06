// Pure help for the kage command: the closest real command to a mistyped one.

// Edits between two words, where two swapped letters count as one slip ("stauts" is one from "status").
const distance = (a: string, b: string) => {
  const d = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)))
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1))
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i]![j] = Math.min(d[i]![j]!, d[i - 2]![j - 2]! + 1)
    }
  }
  return d[a.length]![b.length]!
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
