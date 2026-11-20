import { chatText, checkDream, DREAM_LIMITS, type DreamLesson } from '../../core/dream.ts'

export type DreamCase = { name: string; threads: Record<string, [string, string][]>; proposals: DreamLesson[]; learned: string[]; never: string[] }

const line = ([role, text]: [string, string]) => JSON.stringify(role === 'user' ? { type: 'user', message: { content: text } } : { type: 'assistant', message: { content: [{ type: 'text', text }] } })

export function scoreDream(c: DreamCase, proposals = c.proposals): string[] {
  const chats = Object.fromEntries(Object.entries(c.threads).map(([k, turns]) => [k, chatText(turns.map(line))]))
  const kept = new Set(checkDream(proposals, chats, DREAM_LIMITS).kept.map(l => l.file))
  return [...c.learned.filter(f => !kept.has(f)).map(f => `not learned: ${f}`), ...c.never.filter(f => kept.has(f)).map(f => `learned but never should be: ${f}`)]
}
