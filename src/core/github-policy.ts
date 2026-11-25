import { matchesGlob } from 'node:path'
import { z } from 'zod'

const text = z.string().min(1)
const globs = z.array(text).min(1)
const Rule = z.strictObject({
  name: text,
  targets: globs.optional(),
  anyFile: globs.optional(),
  moreLinesThan: z.number().int().nonnegative().optional(),
  then: z.enum(['approve', 'person']),
})
const PolicyFile = z.strictObject({ people: z.array(text).min(1), rules: z.array(Rule).min(1) })
const FirstPolicyFile = z.strictObject({ authors: z.array(text).min(1), needsPerson: z.array(text).optional() })

export type PolicyRule = z.infer<typeof Rule>
export type ApprovePolicy = { people: string[]; rules: PolicyRule[]; source: string }
type RuleFacts = { base: string; files: string[]; lines: number }

const issues = (source: string, e: z.ZodError) => ({ error: `${source}: ${e.issues.map(i => `${i.path.join('.') || 'file'} ${i.message}`).join('; ')}` })

function fromFirstShape(f: z.infer<typeof FirstPolicyFile>) {
  const risky: PolicyRule[] = f.needsPerson?.length ? [{ name: 'High-risk paths', anyFile: f.needsPerson, then: 'person' }] : []
  return { people: f.authors, rules: [...risky, { name: 'Everything else', then: 'approve' as const }] }
}

export function parsePolicy(body: string, source: string): ApprovePolicy | { error: string } {
  let raw: unknown
  try { raw = JSON.parse(body) } catch { return { error: `${source} is not valid JSON` } }
  const first = raw !== null && typeof raw === 'object' && 'authors' in raw
  const r = first ? FirstPolicyFile.safeParse(raw) : PolicyFile.safeParse(raw)
  if (!r.success) return issues(source, r.error)
  const shaped = 'authors' in r.data ? fromFirstShape(r.data) : r.data
  return { people: shaped.people.map(p => p.toLowerCase()), rules: shaped.rules, source }
}

const undotted = (path: string) => path.split('/').map(part => part.replace(/^\.+/, '')).join('/')
export const matchesAny = (path: string, patterns: string[]) =>
  patterns.some(g => matchesGlob(path, g) || matchesGlob(undotted(path), undotted(g)))

function holds(rule: PolicyRule, f: RuleFacts) {
  if (rule.targets && !matchesAny(f.base, rule.targets)) return false
  if (rule.anyFile && !f.files.some(file => matchesAny(file, rule.anyFile!))) return false
  if (rule.moreLinesThan !== undefined && f.lines <= rule.moreLinesThan) return false
  return true
}

export const firstRule = (policy: ApprovePolicy, f: RuleFacts) => policy.rules.find(rule => holds(rule, f))
