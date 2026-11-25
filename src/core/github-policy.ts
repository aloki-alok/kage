import { matchesGlob } from 'node:path'
import { z } from 'zod'

const text = z.string().min(1)
const globs = z.array(text).min(1)
const Rule = z.strictObject({
  name: text,
  targets: globs.optional(),
  anyFile: globs.optional(),
  moreLinesThan: z.number().int().nonnegative().optional(),
  author: z.array(text).min(1).optional(),
  branch: globs.optional(),
  onlyFiles: globs.optional(),
  onlyVersionChanges: z.literal(true).optional(),
  then: z.enum(['approve', 'person', 'merge']),
})
const PolicyFile = z.strictObject({ people: z.array(text).min(1), rules: z.array(Rule).min(1) })
const FirstPolicyFile = z.strictObject({ authors: z.array(text).min(1), needsPerson: z.array(text).optional() })

export type PolicyRule = z.infer<typeof Rule>
export type ApprovePolicy = { people: string[]; rules: PolicyRule[]; source: string }
type RuleFacts = { base: string; files: string[]; lines: number; author: string; branch: string; versionOnly?: boolean }

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
  if (rule.author && !rule.author.some(login => login.toLowerCase() === f.author.toLowerCase())) return false
  if (rule.branch && !matchesAny(f.branch, rule.branch)) return false
  if (rule.onlyFiles && !(f.files.length && f.files.every(file => matchesAny(file, rule.onlyFiles!)))) return false
  if (rule.onlyVersionChanges && f.versionOnly !== true) return false
  return true
}

export const firstRule = (policy: ApprovePolicy, f: RuleFacts) => policy.rules.find(rule => holds(rule, f))

export type ChangedFile = { filename: string; patch?: string; previous_filename?: string }
const CHANGELOG = /(^|\/)CHANGELOG\.md$/
const VERSION = String.raw`"\d+\.\d+\.\d+(?:-[\w.]+)?"`
const VERSION_LINE = new RegExp(String.raw`^\s*(?:"(?:version|\.)"\s*:\s*${VERSION},?|version\s*=\s*${VERSION}|export const [A-Z_]*VERSION\s*=\s*${VERSION};\s*// x-release-please-version)\s*$`)
const changedLines = (patch: string) => patch.split('\n').filter(l => /^[-+]/.test(l) && !/^(---|\+\+\+) /.test(l)).map(l => l.slice(1))

export const onlyVersionChanges = (files: ChangedFile[]) => files.length > 0 && files.every(f =>
  !f.previous_filename && f.patch !== undefined && (CHANGELOG.test(f.filename) || changedLines(f.patch).every(l => VERSION_LINE.test(l))))
