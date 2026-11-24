import { oneLine } from '../../core/text.ts'
import { openWaiting } from '../../core/ledgers.ts'
import { ASK_KINDS, decide, type AskRef } from '../../core/trust.ts'
import type { Result, ToolContext } from '../kage-tools.ts'

const MAX_REACH = 200
const sameWords = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()

export function typedAsk(c: ToolContext, key: string, kind: string | undefined, reach: string | undefined): AskRef | Result | undefined {
  if (!kind && !reach) return undefined
  if (!kind || !reach?.trim()) return { isError: true, text: 'not sent: an ask names both kind and reach, or neither' }
  if (!ASK_KINDS.includes(kind)) return { isError: true, text: `not sent: kind must be one of ${ASK_KINDS.join(', ')}` }
  if (oneLine(reach).length > MAX_REACH) return { isError: true, text: `not sent: reach is longer than ${MAX_REACH} characters` }
  const who = c.askers.get(key)?.id
  return who ? { who, kind, reach: oneLine(reach) } : undefined
}

export function trustVerdict(c: ToolContext, key: string, ask: string, typed: AskRef | undefined): { result: Result } | { would: string } {
  const mode = c.o.trust?.mode() ?? 'off'
  if (mode === 'off') return { would: '' }
  const d = typed ? decide(c.o.trust!.lines(), typed) : undefined
  const would = !d ? '' : d.do === 'ask' ? 'ask' : d.do
  if (typed) c.o.event?.('trust', `${mode} ${would}`)
  if (mode === 'shadow') return { would }
  if (typed && d?.do === 'go') {
    c.append('trust-steps', [key, typed.who, typed.kind, typed.reach, d.line.id])
    return { result: { text: `not asked: the owner already said yes to this for this teammate (line ${d.line.id}). Go ahead with the step and report after.` } }
  }
  if (typed && d?.do === 'no') return { result: { isError: true, text: `not sent: the owner said no to this for this teammate (line ${d.line.id}). Do not do it and do not ask again.` } }
  const open = openWaiting(c.ledger('waiting')).some(i => i.thread === key && (typed ? i.kind === typed.kind && i.reach === typed.reach : sameWords(i.what, ask)))
  return open ? { result: { isError: true, text: 'not sent: the same ask is already open in this thread. Wait for the owner\'s answer.' } } : { would }
}
