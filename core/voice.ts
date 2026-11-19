import type { Step } from './transcript.ts'

export const SKIN = { fire: '45;190;160', lantern: '230;145;40' }
export const MARK = { kage: '✦', working: '•', you: '◆', quiet: '◌', tail: 'ϡ' }
export const FLICKER = ['⋅', '∙', '•', '∙']

export function painter(color: boolean) {
  const paint = (rgb: string) => (s: string) => color ? `\x1b[38;2;${rgb}m${s}\x1b[0m` : s
  const fire = paint(SKIN.fire)
  const lantern = paint(SKIN.lantern)
  return {
    fire,
    lantern,
    command: fire,
    dim: (s: string) => color ? `\x1b[2m${s}\x1b[22m` : s,
    says: (s: string) => `${fire(MARK.kage)} ${s}`,
    needsYou: (s: string) => lantern(`${MARK.you} ${s}`),
    point: (s: string) => `  ${fire('·')} ${s}`,
    ok: (s: string) => `${fire('✓')} ${s}`,
  }
}

export type Tone = 'plain' | 'fire' | 'you' | 'quiet'

const DID: Record<string, string> = { Read: 'I read', Edit: 'I edited', Write: 'I wrote', Grep: 'I searched for', Glob: 'I looked for', WebFetch: 'I opened', WebSearch: 'I searched the web for' }

export function spokenStep(step: Step): { text: string; tone: Tone } {
  const { kind, text } = step
  if (kind === 'task' || kind === 'input') return { text, tone: 'plain' }
  if (kind === 'reply') return { text: `I replied: ${text}`, tone: 'fire' }
  if (kind === 'error') return { text: `Hit an error: ${text}`, tone: 'you' }
  if (kind === 'says') return { text, tone: 'quiet' }
  if (kind === 'Bash') return { text: `I ran: ${text}`, tone: 'quiet' }
  if (DID[kind]) return { text: `${DID[kind]} ${text}`, tone: 'quiet' }
  return { text: text ? `I used ${kind}: ${text}` : `I used ${kind}`, tone: 'quiet' }
}

export const FOX = [
  '⣷⣄⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢀⣴⡇',
  '⢻⣿⡑⢄⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢀⠔⣹⣿⠃',
  '⢸⣿⣇⠈⠳⣄⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢀⡴⠋⢀⣿⣿⠀',
  '⢸⣿⣿⡀⠀⠈⢷⣄⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢀⣴⠏⠀⠀⣸⣿⣿⠀',
  '⠈⣿⣿⣇⠀⣠⣴⣿⣿⣿⣿⣿⣿⠛⣿⣿⣿⣿⣿⣷⣤⡀⢀⣿⣿⡏⠀',
  '⠀⢿⣿⣿⣾⣿⣿⣿⣿⣿⣿⣿⣿⠀⣿⣿⣿⣿⣿⣿⣿⣿⣾⣿⣿⠇⠀',
  '⠀⠈⢿⣿⣿⣟⡻⠿⢿⣿⣿⣿⣿⣿⣿⣿⣿⣿⠿⠿⣛⣿⣿⣿⠏⠀⠀',
  '⠀⠀⠀⢻⣿⣿⣿⣶⣄⡀⣠⣾⣿⣿⣿⣦⡀⣀⣴⣾⣿⣿⣿⠃⠀⠀⠀',
  '⠀⠀⠀⠀⠙⢿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⠟⠁⠀⠀⠀⠀',
  '⠀⠀⠀⠀⠀⠈⠻⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⡿⠋⠀⠀⠀⠀⠀⠀',
  '⠀⠀⠀⠀⠀⠀⠀⠈⢻⣿⣿⣿⣿⣿⣿⣿⣿⣿⠋⠀⠀⠀⠀⠀⠀⠀⠀',
  '⠀⠀⠀⠀⠀⠀⠀⠀⠀⠙⢿⣷⡄⠀⣴⣿⠟⠁⠀⠀⠀⠀⠀⠀⠀⠀⠀',
  '⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠙⢿⣾⠟⠁⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀',
]
