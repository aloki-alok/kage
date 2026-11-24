import { cardAnswer } from './gate.ts'
import { openWaiting } from './ledgers.ts'
import { oneLine } from './text.ts'

export type TrustMode = 'off' | 'shadow' | 'on'

const LEARNABLE = ['prod-read', 'site-read', 'repo-read']
const NEVER_LEARN = ['ssm-relay', 'money', 'delete', 'send-outside', 'prod-deploy', 'prod-write', 'prod-shell', 'secret', 'product', 'owner-shell']
export const ASK_KINDS = [...LEARNABLE, ...NEVER_LEARN]
export const isLearnable = (kind: string) => LEARNABLE.includes(kind)

export type TrustLine = { id: string; who: string; kind: string; reach: string; answer: 'yes' | 'no'; once: boolean; link: string; at: string; state: 'proposed' | 'live' | 'revoked' }
export type AskRef = { who: string; kind: string; reach: string }
export type Decision = { do: 'go' | 'no'; line: TrustLine } | { do: 'ask'; why: 'never-learn' | 'unknown-kind' | 'no-line' }

export function decide(lines: TrustLine[], ask: AskRef): Decision {
  if (NEVER_LEARN.includes(ask.kind)) return { do: 'ask', why: 'never-learn' }
  if (!isLearnable(ask.kind)) return { do: 'ask', why: 'unknown-kind' }
  const mine = lines.filter(l => l.state === 'live' && l.who === ask.who && l.kind === ask.kind && l.reach === ask.reach)
  const no = mine.find(l => l.answer === 'no')
  if (no) return { do: 'no', line: no }
  const yes = mine.find(l => l.answer === 'yes' && !l.once)
  return yes ? { do: 'go', line: yes } : { do: 'ask', why: 'no-line' }
}

type OpenAsk = AskRef & { thread: string; would: string }

export const openTypedAsks = (waitingTsv: string, thread: string): OpenAsk[] =>
  openWaiting(waitingTsv).filter(i => i.thread === thread && i.kind && i.reach && i.who).map(i => ({ thread, who: i.who!, kind: i.kind!, reach: i.reach!, would: i.would ?? '' }))

const OWNER_LINE = /^(?:Task from [^:\n]*|From the owner, typed in the terminal): ([^\n]*)/

export const ownerWords = (content: string): string | undefined => OWNER_LINE.exec(content)?.[1]

const PLAIN_ANSWER = /^(y|yes|ok|okay|sure|approve|approved|go|n|no|deny)(?:[,. ]+once)?[.!]?$/i

export function answerLines(asks: OpenAsk[], words: string): (AskRef & { answer: 'yes' | 'no'; once: boolean })[] {
  const plain = words.replaceAll('`', '').trim()
  const [ask] = asks
  if (asks.length !== 1 || !ask || !isLearnable(ask.kind) || !PLAIN_ANSWER.test(plain)) return []
  const answer = cardAnswer(plain)
  if (!answer) return []
  return [{ who: ask.who, kind: ask.kind, reach: ask.reach, answer, once: answer === 'yes' && /\bonce\b/i.test(plain) }]
}

export const savedLine = (a: AskRef) => `A yes saves this for <@${a.who}>: ${a.kind} on ${oneLine(a.reach).slice(0, 80)}, from now on. Say "yes once" to keep it to this time.`

export function receiptLine(steps: string[][]): string | undefined {
  if (!steps.length) return undefined
  const rows = steps.map(([, who = '', kind = '', reach = '', line = '']) => `• <@${who}> ${oneLine(kind)} ${oneLine(reach).slice(0, 80)} (line ${oneLine(line)})`)
  return [`*Steps Kage took on its own (${steps.length})*`, ...rows, 'Each went ahead because of the line named. `kage trust revoke <id>` takes one back.'].join('\n')
}

export function trustTable(lines: TrustLine[], proposedOnly: boolean): string {
  const shown = lines.filter(l => proposedOnly ? l.state === 'proposed' : l.state !== 'revoked')
  if (!shown.length) return proposedOnly ? '(no proposed lines)' : '(no lines)'
  return shown.map(l => [l.id, l.who, l.kind, l.reach, l.once ? `${l.answer} once` : l.answer, l.state, l.at.slice(0, 10)].map((c, i) => c.padEnd([5, 12, 12, 24, 9, 9, 0][i]!)).join(' ').trimEnd()).join('\n')
}
