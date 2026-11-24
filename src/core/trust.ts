import { cardAnswer } from './gate.ts'
import { openWaiting } from './ledgers.ts'
import { oneLine } from './text.ts'

export const TRUST_MODES = ['off', 'shadow', 'on'] as const
export type TrustMode = typeof TRUST_MODES[number]

const LEARNABLE = ['prod-read', 'ssm-relay', 'site-read', 'repo-read']
const NEVER_LEARN = ['money', 'delete', 'send-outside', 'prod-deploy', 'prod-write', 'prod-shell', 'secret', 'product', 'owner-shell']
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

export type OpenAsk = AskRef & { thread: string; would: string }

export const openTypedAsks = (waitingTsv: string, thread: string): OpenAsk[] =>
  openWaiting(waitingTsv).filter(i => i.thread === thread && i.kind && i.reach && i.who).map(i => ({ thread, who: i.who, kind: i.kind, reach: i.reach, would: i.would }))

const OWNER_LINE = /^(?:Task from [^:\n]*|From the owner, typed in the terminal): ([^\n]*)/

export const ownerWords = (content: string): string | undefined => OWNER_LINE.exec(content)?.[1]

export function answerLines(asks: OpenAsk[], words: string): (AskRef & { answer: 'yes' | 'no'; once: boolean })[] {
  const plain = words.replaceAll('`', '').trim()
  const answer = cardAnswer(plain)
  if (!answer) return []
  const once = answer === 'yes' && /\bonce\b/i.test(plain)
  return asks.filter(a => isLearnable(a.kind)).map(a => ({ who: a.who, kind: a.kind, reach: a.reach, answer, once }))
}

export function receiptLine(steps: string[][]): string | undefined {
  if (!steps.length) return undefined
  const rows = steps.map(([, who = '', kind = '', reach = '', line = '']) => `• <@${who}> ${oneLine(kind)} ${oneLine(reach).slice(0, 80)} (line ${oneLine(line)})`)
  return [`*Steps Kage took on its own (${steps.length})*`, ...rows, 'Each went ahead because of the line named. `kage trust revoke <id>` takes one back.'].join('\n')
}
