// Tripwires: a shell probe runs on a clock and wakes a session only when its normalized output changes. Pure: the
// process and the file hashes are runtime/probes.ts, and the stored JobState is the caller's.
import { createHash } from 'node:crypto'

// pins: absolute script path to its sha256 hex, taken when the owner approved the probe.
export type Probe = { command: string; pins: Record<string, string>; ignore: string[] }
export type JobState = { fp?: string; last?: string; fails: number; shadowUntil?: number }

// Drops lines that match any ignore regex (a timestamp, a counter) so only real change shows, and trims trailing space.
export const normalize = (out: string, ignore: string[]): string => {
  const res = ignore.map(r => new RegExp(r))
  return out.split('\n').filter(l => !res.some(r => r.test(l))).map(l => l.trimEnd()).join('\n').trimEnd()
}

export const fingerprint = (text: string): string => createHash('sha256').update(text).digest('hex')

// The words of a command that look like files (start with / ~/ or ./), with ~ expanded. Quotes around a word are dropped.
export const scriptPaths = (command: string, home: string): string[] =>
  command.split(/\s+/).map(w => w.replace(/^['"]|['"]$/g, '')).filter(w => /^(\/|~\/|\.\/)/.test(w)).map(w => (w.startsWith('~/') ? home + w.slice(1) : w))

// The pinned paths whose hash differs now. A missing file (undefined) counts as changed.
export const pinsChanged = (pins: Record<string, string>, now: Record<string, string | undefined>): string[] =>
  Object.keys(pins).filter(p => now[p] !== pins[p])

// One run's outcome. A failure never stops the job: it counts, and pings once when the count reaches failPing.
// A change wakes with the previous text, so the session sees what moved. The first good run only records a baseline.
export function decide(state: JobState, run: { ok: boolean; out: string }, probe: Probe, o: { failPing: number }): { state: JobState; wake?: { before?: string; after: string }; ping?: string } {
  if (!run.ok) {
    const fails = state.fails + 1
    return { state: { ...state, fails }, ...(fails === o.failPing && { ping: `A tripwire probe failed ${fails} times in a row: ${probe.command}` }) }
  }
  const after = normalize(run.out, probe.ignore)
  const fp = fingerprint(after)
  const next = { ...state, fp, last: after, fails: 0 }
  if (state.fp === fp) return { state: { ...state, fails: 0 } }
  if (state.fp === undefined) return { state: next }
  return { state: next, wake: { before: state.last, after } }
}
