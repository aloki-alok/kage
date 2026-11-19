import { createHash } from 'node:crypto'
import type { Shadow } from './shadow.ts'

export type Probe = { command: string; pins: Record<string, string>; ignore: string[]; reads: string[]; writes: string[] }
export type JobState = { missing?: string[]; shadow?: Shadow; fp?: string; last?: string; fails: number; refused?: string; undelivered?: true; blocked?: number; pending?: { text: string; f: Record<string, string | number>; tries: number; dm?: true } }
export type Trigger =
  | { kind: 'probe'; probe: Probe }
  | { kind: 'channel'; channel: string; match?: string; bots: boolean }
  | { kind: 'hook'; tokenHash: string }
export const triggerLine = (t: Trigger) =>
  t.kind === 'probe' ? `probe: ${t.probe.command}`
    : t.kind === 'channel' ? `watches ${t.channel}${t.match ? ` for /${t.match}/` : ''}${t.bots ? ', bots too' : ', every post by a person'}`
      : 'webhook'

export const hookTokenHash = (token: string) => createHash('sha256').update(token).digest('hex')
export const eventNeedsCard = (tool: string, input: Record<string, unknown>, sender?: string) =>
  tool === 'mcp__kage__schedule' && (input.hook === true || input.on_channel != null) && sender !== 'owner'

const dropped = (l: string, res: RegExp[], lineMax: number) => l.length <= lineMax && res.some(r => r.test(l))

export const normalize = (out: string, ignore: string[], lineMax: number): string => {
  const res = ignore.map(r => new RegExp(r))
  return out.split('\n').filter(l => !dropped(l, res, lineMax)).map(l => l.trimEnd()).join('\n').trimEnd()
}

export function lineHasher(ignore: string[], lineMax: number) {
  const res = ignore.map(r => new RegExp(r))
  const hash = createHash('sha256')
  let partial = '', started = false, blanks = 0
  let long = false, ws = '', opened = false
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

export function safePattern(p: string, patternMax: number): string | undefined {
  if (p.length > patternMax) return `pattern is longer than ${patternMax} characters`
  try { new RegExp(p) } catch { return 'pattern is invalid' }
  const groups: boolean[] = [false]
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

export function commandWords(command: string, home: string): { words: string[]; cds: string[]; outs: string[] } {
  const expand = (w: string) => (w === '~' ? home : w.startsWith('~/') ? home + w.slice(1) : w)
  const text = command.replace(/\$\{?HOME\}?/g, home)
  const words = text.split(/[\s;&|()$`"'<>=]+/).filter(Boolean).map(expand)
  const redirects = [...text.matchAll(/(?:\d|&)?>>?\s*['"]?([^\s;&|()<>'"]+)/g)].map(m => m[1]!)
  const tees = [...text.matchAll(/\btee((?:\s+[^\s;&|()<>]+)+)/g)].flatMap(m => m[1]!.trim().split(/\s+/)).filter(w => !w.startsWith('-'))
  return { words, cds: words.filter((_, i) => words[i - 1] === 'cd'), outs: [...redirects, ...tees].map(expand) }
}

export const pinsChanged = (pins: Record<string, string>, now: Record<string, string | undefined>): string[] =>
  Object.keys(pins).filter(p => now[p] !== pins[p])

const ERROR_LINE_MAX = 200
const firstLine = (s: string) => (s.split('\n').map(l => l.trim()).find(Boolean) ?? '').slice(0, ERROR_LINE_MAX)

export function decide(state: JobState, run: { ok: boolean; out: string; fp: string; err?: string; refused?: string }, probe: Probe, o: { failPing: number; lineMax: number }): { state: JobState; wake?: { before?: string; after: string }; ping?: string } {
  if (run.refused) {
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
