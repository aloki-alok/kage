import { matchesGlob } from 'node:path'

export type ApprovePolicy = { authors: string[]; riskyPaths: string[] }
export type CheckResult = 'pass' | 'fail' | 'pending'
export type PrFacts = {
  repo: string; number: number; sha: string; author: string
  open: boolean; draft: boolean; fromFork: boolean; baseProtected: boolean
  requiredChecks: string[]; checks: { name: string; result: CheckResult }[]
  files: string[]; filesCut: boolean; approvedShas: string[]
}
export type ApprovalVerdict =
  | { kind: 'approve'; body: string }
  | { kind: 'wait'; why: string }
  | { kind: 'skip'; why: string }
  | { kind: 'human'; why: string }

export type ApprovalEvent = { repo: string; installation: number } & ({ prs: number[] } | { sha: string })

const short = (sha: string) => sha.slice(0, 7)
const PR_ACTIONS = new Set(['opened', 'synchronize', 'reopened', 'ready_for_review'])

type Raw = {
  action?: string; repository?: { full_name?: string }; installation?: { id?: number }
  pull_request?: { number?: number }; check_suite?: { pull_requests?: { number?: number }[] }; sha?: string; state?: string
}

export function approvalEvent(type: string, raw: unknown): ApprovalEvent | undefined {
  const p = (raw ?? {}) as Raw, repo = p.repository?.full_name, installation = p.installation?.id
  if (!repo || installation === undefined) return undefined
  const numbers = (list: (number | undefined)[]) => list.filter((n): n is number => typeof n === 'number')
  if (type === 'pull_request' && PR_ACTIONS.has(p.action ?? '')) return { repo, installation, prs: numbers([p.pull_request?.number]) }
  if (type === 'check_suite' && p.action === 'completed') return { repo, installation, prs: numbers((p.check_suite?.pull_requests ?? []).map(x => x.number)) }
  if (type === 'status' && p.sha && p.state !== 'pending') return { repo, installation, sha: p.sha }
  return undefined
}

function notEligible(policy: ApprovePolicy, f: PrFacts): string | undefined {
  const authors = new Set(policy.authors.map(a => a.toLowerCase()))
  if (!f.open) return 'it is closed'
  if (f.draft) return 'it is a draft'
  if (f.fromFork) return 'it comes from a fork'
  if (!f.baseProtected) return 'its base branch is not protected'
  if (!authors.has(f.author.toLowerCase())) return `${f.author} is not a listed author`
  if (f.approvedShas.includes(f.sha)) return `commit ${short(f.sha)} is already approved`
  return undefined
}

function requiredState(f: PrFacts) {
  const latest = new Map(f.checks.map(c => [c.name, c.result]))
  const state = (name: string) => latest.get(name) ?? 'pending'
  return {
    failed: f.requiredChecks.filter(n => state(n) === 'fail'),
    waiting: f.requiredChecks.filter(n => state(n) === 'pending'),
  }
}

export function approvalVerdict(policy: ApprovePolicy, f: PrFacts): ApprovalVerdict {
  const thread = `${f.repo}#${f.number}`
  const skip = notEligible(policy, f)
  if (skip) return { kind: 'skip', why: `${thread}: ${skip}` }
  if (f.filesCut) return { kind: 'human', why: `${thread} changes more files than Kage reads, so it cannot rule out a high-risk path` }
  const risky = f.files.filter(file => policy.riskyPaths.some(p => matchesGlob(file, p)))
  if (risky.length) return { kind: 'human', why: `${thread} touches high-risk paths: ${risky.slice(0, 5).join(', ')}${risky.length > 5 ? ` and ${risky.length - 5} more` : ''}` }
  const { failed, waiting } = requiredState(f)
  if (failed.length) return { kind: 'skip', why: `${thread}: required check failed: ${failed.join(', ')}` }
  if (waiting.length) return { kind: 'wait', why: `${thread}: waiting on ${waiting.join(', ')}` }
  return { kind: 'approve', body: approvalBody(f) }
}

function approvalBody(f: PrFacts) {
  const checks = f.requiredChecks.length ? `${f.requiredChecks.join(', ')} passed` : 'none set on this branch'
  return [
    'Approved by Kage under the change policy: a listed author, green required checks, no high-risk path.',
    '',
    `- Commit: ${short(f.sha)}`,
    `- Author: ${f.author} (listed author)`,
    `- Required checks: ${checks}`,
    `- Files: ${f.files.length}`,
    '- High-risk paths: none touched',
    '',
    'A new push clears this approval, and Kage checks the new commit again.',
  ].join('\n')
}
