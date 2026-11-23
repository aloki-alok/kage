import { z } from 'zod'
import { quotedLine } from './text.ts'

const element = z.object({ ref: z.number().int().positive(), role: z.string(), label: z.string(), value: z.string().optional(), enabled: z.boolean(), actions: z.array(z.string()) })
const look = z.object({
  snapshot: z.number().int().positive(), app: z.string(), window: z.string(), total: z.number().int().nonnegative(), complete: z.boolean(),
  focused: z.object({ role: z.string(), label: z.string() }), elements: z.array(element),
})
export type Look = z.infer<typeof look>
export type LookElement = z.infer<typeof element>

export function parseLook(answer: Record<string, unknown>): Look | { error: string } {
  if (typeof answer.error === 'string') return { error: answer.error }
  const parsed = look.safeParse(answer)
  return parsed.success ? parsed.data : { error: 'Kage Screen answered a look in a shape the hub does not know: it may run an older build, so try again' }
}

export const roleWords = (role: string) => role.replace(/^AX/, '').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase() || 'element'
const quoted = (s: string) => `"${quotedLine(s)}"`

function elementLine(e: LookElement) {
  const value = e.value !== undefined && e.value !== e.label ? ` = ${quoted(e.value)}` : ''
  return `[r${e.ref}] ${roleWords(e.role)} ${quoted(e.label)}${value}${e.enabled ? '' : ' (disabled)'}`
}

export function lookText(l: Look): string {
  const focus = l.focused.role ? `${roleWords(l.focused.role)} ${quoted(l.focused.label)}` : 'nothing'
  const left = l.total - l.elements.length
  const tail = [left > 0 ? `${left} more not shown: look with find to narrow it.` : '', l.complete ? '' : 'The window was too big to read whole.'].filter(Boolean).join(' ')
  return [`${quotedLine(l.app)}, window ${quoted(l.window)}, look ${l.snapshot}. Focus: ${focus}.`, ...l.elements.map(elementLine), ...tail ? [tail] : []].join('\n')
}
