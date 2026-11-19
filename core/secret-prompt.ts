export type Secret = { prefix: string; name: string }

export const SECRETS = {
  app: { prefix: 'xapp-', name: 'app-level token' },
  user: { prefix: 'xoxp-', name: 'user token' },
  bot: { prefix: 'xoxb-', name: 'bot token' },
  config: { prefix: 'xoxe.xoxp-', name: 'configuration Access Token' },
  refresh: { prefix: 'xoxe-', name: 'configuration Refresh Token' },
  claude: { prefix: 'sk-ant-oat', name: 'Claude token' },
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
    if (ch === '\u001b') { while (i + 1 < chars.length && !ESCAPE_END.test(chars[++i]!)); continue }
    if (ch === '\u007f' || ch === '\b') typed = typed.slice(0, -1)
    else if (ch === '\u0015') typed = ''
    else if (ch >= ' ') typed += ch
  }
  return { typed }
}

const kindOf = (token: string) => KNOWN.find(k => token.startsWith(k.prefix))

export function pickSecret(pasted: string, want: Secret): { value: string; problem?: string } {
  const words = pasted.split(/\s+/).filter(Boolean)
  if (!words.length) return { value: '' }
  const wanted = words.find(w => w.startsWith(want.prefix))
  if (wanted) return { value: wanted }
  const other = kindOf(words[0]!)
  if (other === SECRETS.refresh && want === SECRETS.config) return { value: '', problem: `That is the Refresh Token. Paste the Access Token (${want.prefix}...).` }
  if (other) return { value: '', problem: `That is a ${other.name} (${other.prefix}...). Paste the ${want.name} (${want.prefix}...).` }
  return { value: '', problem: `That does not look like a ${want.name}. It starts with ${want.prefix}` }
}

export const shownAs = (token: string) => `${kindOf(token)?.prefix ?? token.slice(0, 4)}… (${token.length} characters)`
