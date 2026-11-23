import { heldCommand } from './held.ts'

const OWNER_ONLY = new Set(['a command as root', 'erasing a disk or file', 'a recursive permission change', 'a cron change', 'a write to a system folder', 'a shutdown', 'a command nested too deep to read', 'a push to a protected branch'])
const UNSAFE = /[\s;&|<>()`$'"\\{}[\]?*~!#:]|\.\.|%2e/i
const safeFill = (fill: string) => fill !== '' && !fill.startsWith('-') && !UNSAFE.test(fill)
function wordMatches(rule: string, word: string): boolean {
  const [head = '', ...parts] = rule.split('*')
  if (!parts.length) return rule === word
  if (!word.startsWith(head)) return false
  let at = head.length
  for (const [i, part] of parts.entries()) {
    const next = i < parts.length - 1 ? word.indexOf(part, at + 1) : word.endsWith(part) ? word.length - part.length : -1
    if (next < at || !safeFill(word.slice(at, next))) return false
    at = next + part.length
  }
  return !/\.\.|%2e/i.test(word)
}
export const badRule = (rule: string) => /^\S*\*/.test(rule.trim())
export function allowedBy(rules: string[], command: string): string | undefined {
  const kind = heldCommand(command)
  if (!kind || OWNER_ONLY.has(kind)) return undefined
  const words = command.trim().split(/[ \t]+/)
  return rules.find(r => { const want = r.trim().split(/\s+/); return !badRule(r) && want.length === words.length && want.every((w, i) => wordMatches(w, words[i]!)) })
}
