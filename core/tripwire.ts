// Tripwires: a shell probe runs on a clock and wakes a session only when its normalized output changes. Pure: the
// process and the file hashes are runtime/probes.ts, and the stored JobState is the caller's.
import { createHash } from 'node:crypto'
import { basename, resolve } from 'node:path'

// pins: absolute script path to its sha256 hex, taken when the owner approved the probe.
export type Probe = { command: string; pins: Record<string, string>; ignore: string[] }
export type JobState = { fp?: string; last?: string; fails: number }

// Drops lines that match any ignore regex (a timestamp, a counter) so only real change shows, and trims trailing space.
// A regex reads at most lineMax characters of a line. The patterns passed safePattern when the probe was made.
export const normalize = (out: string, ignore: string[], lineMax: number): string => {
  const res = ignore.map(r => new RegExp(r))
  return out.split('\n').filter(l => !res.some(r => r.test(l.slice(0, lineMax)))).map(l => l.trimEnd()).join('\n').trimEnd()
}

// Why an ignore pattern is refused, or undefined when it is fine. Patterns are model-authored and run in the hub, so a
// pattern that is invalid, too long, or repeats a group that already repeats ((a+)+) never runs.
// ponytail: catches nested repeats only, not overlapping alternation like (a|a)+. Upgrade: a safe-regex engine such as RE2.
export function safePattern(p: string, patternMax: number): string | undefined {
  if (p.length > patternMax) return `pattern is longer than ${patternMax} characters`
  try { new RegExp(p) } catch { return 'pattern is invalid' }
  const groups: boolean[] = [false] // per open group: does it hold a repeat
  for (let i = 0; i < p.length; i++) {
    const c = p[i]
    if (c === '\\') i++
    else if (c === '[') { while (i < p.length - 1 && p[++i] !== ']') if (p[i] === '\\') i++ }
    else if (c === '(') groups.push(false)
    else if (c === '+' || c === '*' || c === '{') groups[groups.length - 1] = true
    else if (c === ')') {
      const held = groups.pop()!
      const repeated = /[+*{]/.test(p[i + 1] ?? '')
      if (held && repeated) return 'pattern repeats a group that already repeats (nested quantifier)'
      groups[groups.length - 1] ||= held || repeated
    }
  }
}

export const fingerprint = (text: string): string => createHash('sha256').update(text).digest('hex')

const DEFAULT_INTERPRETERS = ['sh', 'bash', 'zsh', 'python', 'python3', 'node', 'ruby', 'perl', 'bun', 'deno']
const unquote = (w: string) => w.replace(/^['"]|['"]$/g, '')

// The files a command runs: the head word of each segment (split on ; && || | & and newlines) when it is a path, and the
// first non-flag word after an interpreter. `cd <dir>` moves where later relative paths resolve. A word that only names
// data (`wc -l app.log`) is not here. Paths are absolute, ~ is expanded, and a ./ path resolves against cwd or the cd.
export function scriptPaths(command: string, home: string, cwd: string, interpreters: string[] = DEFAULT_INTERPRETERS): string[] {
  const where = (w: string, dir: string) => (w.startsWith('~/') ? home + w.slice(1) : w.startsWith('/') ? w : resolve(dir, w))
  const found: string[] = []
  let dir = cwd
  for (const seg of command.split(/&&|\|\||[;|&\n]/)) {
    const words = seg.split(/\s+/).filter(Boolean).map(unquote)
    while (/^[A-Za-z_]\w*=/.test(words[0] ?? '')) words.shift()
    const [head, ...rest] = words
    if (!head) continue
    if (head === 'cd') { if (rest[0]) dir = where(rest[0], dir); continue }
    if (/^(\/|~\/|\.{1,2}\/)/.test(head)) found.push(where(head, dir))
    if (interpreters.includes(basename(head))) { const arg = rest.find(w => !w.startsWith('-')); if (arg) found.push(where(arg, dir)) }
  }
  return found
}

// The pinned paths whose hash differs now. A missing file (undefined) counts as changed.
export const pinsChanged = (pins: Record<string, string>, now: Record<string, string | undefined>): string[] =>
  Object.keys(pins).filter(p => now[p] !== pins[p])

const ERROR_LINE_MAX = 200
const firstLine = (s: string) => (s.split('\n').map(l => l.trim()).find(Boolean) ?? '').slice(0, ERROR_LINE_MAX)

// One run's outcome. A failure never stops the job: it counts, and pings once when the count reaches failPing, naming
// the first line of stderr (or of stdout when stderr is empty). A change wakes with the previous text, so the session
// sees what moved. Only stdout is fingerprinted, so a stderr warning cannot wake. The first good run only records a baseline.
export function decide(state: JobState, run: { ok: boolean; out: string; err?: string }, probe: Probe, o: { failPing: number; lineMax: number }): { state: JobState; wake?: { before?: string; after: string }; ping?: string } {
  if (!run.ok) {
    const fails = state.fails + 1
    const why = firstLine(run.err ?? '') || firstLine(run.out)
    return { state: { ...state, fails }, ...(fails === o.failPing && { ping: `A tripwire probe failed ${fails} times in a row: ${probe.command}${why && `\nError: ${why}`}` }) }
  }
  const after = normalize(run.out, probe.ignore, o.lineMax)
  const fp = fingerprint(after)
  const next = { ...state, fp, last: after, fails: 0 }
  if (state.fp === fp) return { state: { ...state, fails: 0 } }
  if (state.fp === undefined) return { state: next }
  return { state: next, wake: { before: state.last, after } }
}
