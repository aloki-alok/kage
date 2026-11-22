import type { Step } from './transcript.ts'

export const SKIN = { work: '45;190;160', you: '230;145;40' }
export const MARK = { kage: '✦', working: '•', you: '◆', quiet: '◌' }
export const FLICKER = ['⋅', '∙', '•', '∙']

export function painter(color: boolean) {
  const paint = (rgb: string) => (s: string) => color ? `\x1b[38;2;${rgb}m${s}\x1b[0m` : s
  const work = paint(SKIN.work)
  const you = paint(SKIN.you)
  return {
    work,
    you,
    command: work,
    dim: (s: string) => color ? `\x1b[2m${s}\x1b[22m` : s,
    faint: (s: string) => color ? `\x1b[2;38;2;90;98;108m${s}\x1b[0m` : s,
    says: (s: string) => `${work(MARK.kage)} ${s}`,
    needsYou: (s: string) => you(`${MARK.you} ${s}`),
    point: (s: string) => `  ${work('·')} ${s}`,
    ok: (s: string) => `${work('✓')} ${s}`,
  }
}

export type Tone = 'plain' | 'work' | 'you' | 'quiet'

const DID: Record<string, string> = { Read: 'I read', Edit: 'I edited', Write: 'I wrote', Grep: 'I searched for', Glob: 'I looked for', WebFetch: 'I opened', WebSearch: 'I searched the web for' }

export function spokenStep(step: Step): { text: string; tone: Tone } {
  const { kind, text } = step
  if (kind === 'task' || kind === 'input') return { text, tone: 'plain' }
  if (kind === 'reply') return { text: `I replied: ${text}`, tone: 'work' }
  if (kind === 'error') return { text: `Hit an error: ${text}`, tone: 'you' }
  if (kind === 'says') return { text, tone: 'quiet' }
  if (kind === 'Bash') return { text: `I ran: ${text}`, tone: 'quiet' }
  if (DID[kind]) return { text: `${DID[kind]} ${text}`, tone: 'quiet' }
  return { text: text ? `I used ${kind}: ${text}` : `I used ${kind}`, tone: 'quiet' }
}

const WORD = ['█▄▀ ▄▀█ █▀▀ █▀▀', '█ █ █▀█ █▄█ ██▄']
const mirror = (row: string) => row.replace(/[▀▄]/g, c => c === '▀' ? '▄' : '▀')
export const WORDMARK = { word: WORD, shadow: [` ${mirror(WORD[1]!)}`, `  ${mirror(WORD[0]!)}`] }

export function besideWordmark(v: ReturnType<typeof painter>, right: string[]): string[] {
  const { word, shadow } = WORDMARK
  const width = Math.max(...[...word, ...shadow].map(l => [...l].length))
  const art = ['', ...word.map(l => l.padEnd(width)), ...shadow.map((l, i) => i ? v.faint(l.padEnd(width)) : v.dim(l.padEnd(width)))]
  return Array.from({ length: Math.max(art.length, right.length) }, (_, i) => `${art[i] ?? ' '.repeat(width)}   ${right[i] ?? ''}`.trimEnd())
}
