export type Secret = { prefix: string; name: string; shape?: { pattern: RegExp; says: string } }

export const SECRETS = {
  app: { prefix: 'xapp-', name: 'app-level token' },
  user: { prefix: 'xoxp-', name: 'user token' },
  bot: { prefix: 'xoxb-', name: 'bot token' },
  signing: { prefix: '', name: 'signing secret', shape: { pattern: /^[0-9a-f]{32}$/, says: '32 characters, 0-9 and a-f' } },
  config: { prefix: 'xoxe.xoxp-', name: 'configuration Access Token' },
  refresh: { prefix: 'xoxe-', name: 'configuration Refresh Token' },
  claude: { prefix: 'sk-ant-oat', name: 'Claude token' },
  github: { prefix: 'gh', name: 'GitHub token' },
} satisfies Record<string, Secret>

const KNOWN: Secret[] = Object.values(SECRETS)

export type Keys = { typed: string; end?: 'enter' | 'cancel' }

const ESCAPE_END = /[A-Za-z~]/

export function typeKeys(state: Keys, chunk: string): Keys {
  let typed = state.typed
  const chars = [...chunk]
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]!
    if (ch === '\u0003') return { typed, end: 'cancel' }
    if (ch === '\r' || ch === '\n' || (ch === '\u0004' && !typed)) return { typed, end: 'enter' }
    if (ch === '\u001b') {
      const intro = chars[++i]
      if (intro === '[') while (i + 1 < chars.length && !ESCAPE_END.test(chars[++i]!));
      else if (intro === 'O') i++
      continue
    }
    if (ch === '\u007f' || ch === '\b') typed = typed.slice(0, -1)
    else if (ch === '\u0015') typed = ''
    else if (ch >= ' ') typed += ch
  }
  return { typed }
}

const isKind = (k: Secret, token: string) => k.shape ? k.shape.pattern.test(token) : token.startsWith(k.prefix)
const kindOf = (token: string) => KNOWN.find(k => isKind(k, token))
const described = (k: Secret) => k.shape ? `${k.name} (${k.shape.says})` : `${k.name} (${k.prefix}...)`

export function pickSecret(pasted: string, want: Secret): { value: string; problem?: string } {
  const words = pasted.split(/\s+/).filter(Boolean)
  if (!words.length) return { value: '' }
  const wanted = words.find(w => isKind(want, w))
  if (wanted) return { value: wanted }
  const other = kindOf(words[0]!)
  if (other === SECRETS.refresh && want === SECRETS.config) return { value: '', problem: `That is the Refresh Token. Paste the Access Token (${want.prefix}...).` }
  if (other?.shape) return { value: '', problem: `That is a ${other.name}. Paste the ${described(want)}.` }
  if (other) return { value: '', problem: `That is a ${described(other)}. Paste the ${described(want)}.` }
  return { value: '', problem: want.shape ? `That does not look like a ${want.name}. It is ${want.shape.says}.` : `That does not look like a ${want.name}. It starts with ${want.prefix}` }
}

export const shownAs = (token: string) => `${kindOf(token)?.prefix ?? token.slice(0, 4)}… (${token.length} characters)`

export type SlackSlots = Partial<Record<'app' | 'user' | 'bot', string>>
const SLACK = [['app', SECRETS.app], ['user', SECRETS.user], ['bot', SECRETS.bot]] as const

export function fillSlackTokens(slots: SlackSlots, pasted: string): { slots: SlackSlots; problem?: string } {
  const next = { ...slots }
  let problem: string | undefined
  for (const word of pasted.split(/\s+/).filter(Boolean)) {
    const slot = SLACK.find(([, s]) => word.startsWith(s.prefix))
    if (slot) { next[slot[0]] = word; continue }
    const other = kindOf(word)
    problem = other ? `That is a ${other.name}. Paste the tokens that start with xapp-, xoxp- or xoxb-.` : 'That is not a Slack token. They start with xapp-, xoxp- or xoxb-.'
  }
  return problem ? { slots: next, problem } : { slots: next }
}

export function typeLines(typed: string, chunk: string): { typed: string; lines: string[]; cancel?: boolean } {
  const segments = chunk.split(/\r\n|\r|\n/), lines: string[] = []
  let state: Keys = { typed }
  for (let i = 0; i < segments.length; i++) {
    state = typeKeys(state, segments[i]!)
    if (state.end === 'cancel') return { typed: state.typed, lines, cancel: true }
    if (i < segments.length - 1 || state.end === 'enter') { lines.push(state.typed); state = { typed: '' } }
  }
  return { typed: state.typed, lines }
}
