import type { Step } from './transcript.ts'

export const PALETTE = { red: '255;77;61', gold: '255;215;94', green: '127;208;138' }

export function painter(color: boolean) {
  const paint = (rgb: string) => (s: string) => color ? `\x1b[38;2;${rgb}m${s}\x1b[0m` : s
  const red = paint(PALETTE.red)
  return {
    red,
    command: paint(PALETTE.gold),
    dim: (s: string) => color ? `\x1b[2m${s}\x1b[22m` : s,
    says: (s: string) => `${red('◆')} ${s}`,
    point: (s: string) => `  ${red('›')} ${s}`,
    ok: (s: string) => `${paint(PALETTE.green)('✓')} ${s}`,
  }
}

export type Tone = 'loud' | 'red' | 'quiet'

const DID: Record<string, string> = { Read: 'I read', Edit: 'I edited', Write: 'I wrote', Grep: 'I searched for', Glob: 'I looked for', WebFetch: 'I opened', WebSearch: 'I searched the web for' }

export function spokenStep(step: Step): { text: string; tone: Tone } {
  const { kind, text } = step
  if (kind === 'task' || kind === 'input') return { text, tone: 'loud' }
  if (kind === 'reply') return { text: `I replied: ${text}`, tone: 'red' }
  if (kind === 'error') return { text: `Hit an error: ${text}`, tone: 'red' }
  if (kind === 'says') return { text, tone: 'quiet' }
  if (kind === 'Bash') return { text: `I ran: ${text}`, tone: 'quiet' }
  if (DID[kind]) return { text: `${DID[kind]} ${text}`, tone: 'quiet' }
  return { text: text ? `I used ${kind}: ${text}` : `I used ${kind}`, tone: 'quiet' }
}
