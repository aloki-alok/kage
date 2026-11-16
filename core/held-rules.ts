// The owner's allow: lines in a kagelet's job.md (ADR 0018): which held shell step each one releases, matched by code with no model.
import { heldCommand } from './held.ts'

// Kinds only the owner releases, one step at a time: no rule line, reviewer or learned rule covers them.
const OWNER_ONLY = new Set(['a command as root', 'erasing a disk or file', 'a recursive permission change', 'a cron change', 'a write to a system folder', 'a shutdown', 'a command nested too deep to read', 'a push to a protected branch'])
// What a rule's * never stands for: whitespace, quotes and shell syntax (a second command, a variable, or a glob or brace
// the shell widens), a refspec colon, a step up (.. or %2e). A * covers at least one character and never starts a flag.
const UNSAFE = /[\s;&|<>()`$'"\\{}[\]?*~!#:]|\.\.|%2e/i
const safeFill = (fill: string) => fill !== '' && !fill.startsWith('-') && !UNSAFE.test(fill)
// One command word against one rule word, left to right with indexOf, so it stays linear however many stars a rule has.
// It takes the first place each literal part fits, and refuses rather than search further.
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
  return !/\.\.|%2e/i.test(word)   // a literal part next to a * could finish a step up the fill began
}
// A rule is the owner's (ADR 0018): it starts with a literal command word, so it names the tool it releases.
export const badRule = (rule: string) => /^\S*\*/.test(rule.trim())
// The owner's rule line that releases this held step, matched by code with no model: the same number of words, each matching.
export function allowedBy(rules: string[], command: string): string | undefined {
  const kind = heldCommand(command)
  if (!kind || OWNER_ONLY.has(kind)) return undefined
  const words = command.trim().split(/[ \t]+/)
  return rules.find(r => { const want = r.trim().split(/\s+/); return !badRule(r) && want.length === words.length && want.every((w, i) => wordMatches(w, words[i]!)) })
}
