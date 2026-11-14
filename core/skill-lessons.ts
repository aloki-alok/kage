// A lesson the dream shares with every install must read the same for any owner. These are the details that
// would tell whose Kage learned it. The dream runs the check (cli/skill-lesson.ts) before it opens a PR.
const ID = /\b[UCDGWAT][0-9A-Z]{8,}\b/
const DATE = /\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}[-/]\d{1,2}\b(?=\W|$)/
const EMAIL = /[\w.+-]+@[\w-]+\.\w+/
const PATH = /\/(Users|home)\/\w+/
const QUOTE = /["“][^"”\n]{3,}["”]/

// names: the owner's and teammates' names, which only the caller knows. Returns what must change, empty when generic.
export function wordingProblems(text: string, names: string[]): string[] {
  const out: string[] = []
  for (const n of names) if (n && new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text)) out.push(`a name: ${n}`)
  if (ID.test(text)) out.push('an id')
  if (DATE.test(text)) out.push('a date')
  if (EMAIL.test(text)) out.push('an email')
  if (PATH.test(text)) out.push('a path')
  if (QUOTE.test(text)) out.push('a quote')
  return out
}
