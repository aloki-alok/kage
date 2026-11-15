// Tripwires: a shell probe runs on a clock and wakes a session only when its normalized output changes. Pure: the
// process and the file hashes are runtime/probes.ts, and the stored JobState is the caller's.
import { createHash } from 'node:crypto'

// pins: absolute script path to its sha256 hex, taken when the owner approved the probe.
// reads: paths the probe reads as data, whose change is the point. writes: paths the probe writes besides a redirect or tee.
// Neither is pinned: a probe that edits its own output must not refuse itself.
export type Probe = { command: string; pins: Record<string, string>; ignore: string[]; reads: string[]; writes: string[] }
export type JobState = { fp?: string; last?: string; fails: number; refused?: string }

// A line an ignore regex drops. A line longer than lineMax is never dropped: a regex that sees only part of it proves nothing.
const dropped = (l: string, res: RegExp[], lineMax: number) => l.length <= lineMax && res.some(r => r.test(l))

// Drops lines that match any ignore regex (a timestamp, a counter) so only real change shows, and trims trailing space.
// The patterns passed safePattern when the probe was made.
export const normalize = (out: string, ignore: string[], lineMax: number): string => {
  const res = ignore.map(r => new RegExp(r))
  return out.split('\n').filter(l => !dropped(l, res, lineMax)).map(l => l.trimEnd()).join('\n').trimEnd()
}

// The sha256 of normalize(all output), taken as the output arrives, so a probe can keep only part of its text and still
// see a change anywhere. Push chunks, then end() for the hex.
export function lineHasher(ignore: string[], lineMax: number) {
  const res = ignore.map(r => new RegExp(r))
  const hash = createHash('sha256')
  let partial = '', started = false, blanks = 0 // blanks: empty lines held back, so trailing ones never count
  // A line past lineMax is never dropped, so it streams into the hash as it arrives (linear time on a huge line with no
  // newline). Only its trailing whitespace waits, so the hash is the same however the output is cut.
  let long = false, ws = '', opened = false // opened: the long line has put non-space text in the hash
  const open = () => { hash.update((started ? '\n' : '') + '\n'.repeat(blanks)); started = true; blanks = 0 }
  const stream = (s: string) => {
    let k = s.length
    while (k > 0 && /\s/.test(s.charAt(k - 1))) k--
    if (k === 0) { ws += s; return }
    if (!opened) { open(); opened = true }
    hash.update(ws + s.slice(0, k))
    ws = s.slice(k)
  }
  const close = () => { if (!opened) blanks++; long = false }
  const line = (l: string) => {
    if (dropped(l, res, lineMax)) return
    const t = l.trimEnd()
    if (!t) { blanks++; return }
    open()
    hash.update(t)
  }
  const piece = (s: string, ends: boolean) => {
    if (!long && partial.length + s.length > lineMax) { long = true; ws = ''; opened = false; stream(partial); partial = '' }
    if (long) { stream(s); if (ends) close(); return }
    if (ends) { line(partial + s); partial = '' } else partial += s
  }
  return {
    push(chunk: string) {
      let at = 0
      for (let i = chunk.indexOf('\n'); i >= 0; at = i + 1, i = chunk.indexOf('\n', at)) piece(chunk.slice(at, i), true)
      piece(chunk.slice(at), false)
    },
    end() { if (long) close(); else line(partial); return hash.digest('hex') },
  }
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

// The words of a command, after splitting on whitespace and shell punctuation (; & | ( ) $ ` " ' < > =) with ~ and $HOME
// expanded, the words that follow a cd, and the outputs (the word after >, >>, 2>, &> and the file words after tee).
// Shell parsing is never complete, so this only has to over-collect: the caller (runtime/probes.ts pin) pins the words
// that turn out to be files, except outputs.
export function commandWords(command: string, home: string): { words: string[]; cds: string[]; outs: string[] } {
  const expand = (w: string) => (w === '~' ? home : w.startsWith('~/') ? home + w.slice(1) : w)
  const text = command.replace(/\$\{?HOME\}?/g, home)
  const words = text.split(/[\s;&|()$`"'<>=]+/).filter(Boolean).map(expand)
  const redirects = [...text.matchAll(/(?:\d|&)?>>?\s*['"]?([^\s;&|()<>'"]+)/g)].map(m => m[1]!)
  const tees = [...text.matchAll(/\btee((?:\s+[^\s;&|()<>]+)+)/g)].flatMap(m => m[1]!.trim().split(/\s+/)).filter(w => !w.startsWith('-'))
  return { words, cds: words.filter((_, i) => words[i - 1] === 'cd'), outs: [...redirects, ...tees].map(expand) }
}

// The pinned paths whose hash differs now. A missing file (undefined) counts as changed.
export const pinsChanged = (pins: Record<string, string>, now: Record<string, string | undefined>): string[] =>
  Object.keys(pins).filter(p => now[p] !== pins[p])

const ERROR_LINE_MAX = 200
const firstLine = (s: string) => (s.split('\n').map(l => l.trim()).find(Boolean) ?? '').slice(0, ERROR_LINE_MAX)

// One run's outcome. A failure never stops the job: it counts, and pings once when the count reaches failPing, naming
// the first line of stderr (or of stdout when stderr is empty). A change wakes with the previous text, so the session
// sees what moved. Only stdout is fingerprinted (run.fp covers all of it, even past the text the run kept), so a stderr warning cannot wake. The first good run only records a baseline.
export function decide(state: JobState, run: { ok: boolean; out: string; fp: string; err?: string; refused?: string }, probe: Probe, o: { failPing: number; lineMax: number }): { state: JobState; wake?: { before?: string; after: string }; ping?: string } {
  if (run.refused) {
    // A refusal never fixes itself, so it pings at once, once per distinct refusal.
    const ping = run.refused === state.refused ? undefined : `A tripwire probe is stopped: ${probe.command}\n${run.refused}\nFix: add a file the probe reads to reads, a file it writes to writes, or approve the probe again.`
    return { state: { ...state, refused: run.refused }, ...(ping && { ping }) }
  }
  if (!run.ok) {
    const fails = state.fails + 1
    const why = firstLine(run.err ?? '') || firstLine(run.out)
    return { state: { ...state, fails }, ...(fails === o.failPing && { ping: `A tripwire probe failed ${fails} times in a row: ${probe.command}${why && `\nError: ${why}`}` }) }
  }
  const after = normalize(run.out, probe.ignore, o.lineMax)
  const fp = run.fp
  const { refused: _, ...kept } = state
  const next = { ...kept, fp, last: after, fails: 0 }
  if (state.fp === fp) return { state: { ...kept, fails: 0 } }
  if (state.fp === undefined) return { state: next }
  return { state: next, wake: { before: state.last, after } }
}
