import { basename } from 'node:path'
import { firstRule, matchesAny, type ApprovePolicy, type PolicyRule } from './github-policy.ts'

export const REPO_POLICY = '.github/kage-approve.json'
export const ORG_POLICY = 'kage-approve.json'
export const CHECK_NAME = 'Kage policy'
export const approveSetting = (set?: { policyRepo?: string }) => set && { policyRepo: set.policyRepo ?? '.github' }
export type CheckResult = 'pass' | 'fail' | 'pending'
export type PrFacts = {
  repo: string; number: number; sha: string; author: string; base: string; branch: string
  open: boolean; draft: boolean; fromFork: boolean; baseProtected: boolean
  requiredChecks: string[]; checks: { name: string; result: CheckResult }[]
  files: string[]; filesCut: boolean; lines: number; pushers: string[] | undefined; headPushed: boolean
}
type Kind = 'skip' | 'stop' | 'person' | 'wait' | 'approve'
export type ApprovalVerdict = { kind: Kind; code: string; why: string; fix: string; rule?: string; body?: string }
type ApprovalEvent = { repo: string; installation: number } & ({ prs: number[] } | { sha: string })

const short = (sha: string) => sha.slice(0, 7)
const listOf = (items: string[], max = 5) => `${items.slice(0, max).join(', ')}${items.length > max ? ` and ${items.length - max} more` : ''}`
const PERSON_FIX = 'A person other than the author approves it on GitHub.'
const PR_ACTIONS = new Set(['opened', 'synchronize', 'reopened', 'ready_for_review', 'converted_to_draft', 'edited'])

type Raw = {
  action?: string; repository?: { full_name?: string }; installation?: { id?: number }; sha?: string; state?: string
  pull_request?: { number?: number }; check_suite?: { app?: { slug?: string }; pull_requests?: { number?: number }[] }
}

export function approvalEvent(type: string, raw: unknown, slug: string): ApprovalEvent | undefined {
  const p = (raw ?? {}) as Raw, repo = p.repository?.full_name, installation = p.installation?.id
  if (!repo || installation === undefined) return undefined
  const numbers = (list: (number | undefined)[]) => list.filter((n): n is number => typeof n === 'number')
  if (type === 'pull_request' && PR_ACTIONS.has(p.action ?? '')) return { repo, installation, prs: numbers([p.pull_request?.number]) }
  if (type === 'check_suite' && p.action === 'completed' && p.check_suite?.app?.slug !== slug) return { repo, installation, prs: numbers((p.check_suite?.pull_requests ?? []).map(x => x.number)) }
  if (type === 'status' && p.sha && p.state !== 'pending') return { repo, installation, sha: p.sha }
  return undefined
}

const v = (kind: Kind, code: string, why: string, fix = '', rule?: string): ApprovalVerdict => ({ kind, code, why, fix, ...(rule && { rule }) })

function gate(policy: ApprovePolicy, f: PrFacts): ApprovalVerdict | undefined {
  const listed = (login: string) => policy.people.includes(login.toLowerCase())
  if (!f.open) return v('skip', 'closed', 'It is closed.')
  if (!listed(f.author)) return v('skip', 'author-not-listed', `${f.author} is not in people.`)
  if (f.draft) return v('stop', 'draft', 'It is a draft.', 'Mark it ready for review.')
  if (f.fromFork) return v('stop', 'fork', 'It comes from a fork.', 'Open it from a branch in this repository.')
  if (!f.baseProtected) return v('stop', 'base-unprotected', `${f.base} is not a protected branch, so it needs no approval.`, 'Merge it, or protect the branch.')
  if (f.filesCut) return v('person', 'too-many-files', 'It changes more files than Kage reads.', PERSON_FIX)
  if (f.files.some(file => basename(file) === ORG_POLICY)) return v('person', 'policy-change', 'It changes a Kage policy file.', PERSON_FIX)
  if (!f.pushers) return v('person', 'pushes-unseen', `Kage cannot see every push to ${f.branch}.`, PERSON_FIX)
  const outside = [...new Set(f.pushers.filter(p => !listed(p)))]
  if (outside.length) return v('person', 'pusher-not-listed', `${listOf(outside)} pushed to ${f.branch}, and is not in people.`, PERSON_FIX)
  if (!f.headPushed) return v('wait', 'push-history-behind', `GitHub's push history does not show commit ${short(f.sha)} yet.`, 'Kage checks again on the next event, and within the hour.')
  return undefined
}

function matched(rule: PolicyRule, f: PrFacts) {
  const parts = [
    ...(rule.targets ? [`it targets ${f.base}`] : []),
    ...(rule.anyFile ? [`it changes ${listOf(f.files.filter(file => matchesAny(file, rule.anyFile!)))}`] : []),
    ...(rule.moreLinesThan !== undefined ? [`it changes ${f.lines} lines`] : []),
  ]
  return parts.length ? `: ${parts.join(', ')}` : ''
}

function requiredState(f: PrFacts) {
  const latest = new Map(f.checks.map(c => [c.name, c.result]))
  const state = (name: string) => latest.get(name) ?? 'pending'
  return { failed: f.requiredChecks.filter(n => state(n) === 'fail'), waiting: f.requiredChecks.filter(n => state(n) === 'pending') }
}

export function approvalVerdict(policy: ApprovePolicy, f: PrFacts): ApprovalVerdict {
  const stopped = gate(policy, f)
  if (stopped) return stopped
  const rule = firstRule(policy, { base: f.base, files: f.files, lines: f.lines })
  if (!rule) return v('stop', 'no-rule', `No rule in ${policy.source} covers it.`, `Add a rule that covers it to ${policy.source}, or ask a person to review.`)
  if (rule.then === 'person') return v('person', 'rule', `Rule "${rule.name}" asks for a person${matched(rule, f)}.`, PERSON_FIX, rule.name)
  const { failed, waiting } = requiredState(f)
  if (failed.length) return v('stop', 'checks-failed', `Required check failed: ${failed.join(', ')}.`, `Fix ${failed.join(', ')}. Kage checks again when they pass.`, rule.name)
  if (waiting.length) return v('wait', 'checks-pending', `Waiting on ${waiting.join(', ')}.`, 'Kage approves once they pass.', rule.name)
  return { ...v('approve', 'approved', `Approved under rule "${rule.name}".`, '', rule.name), body: approvalBody(f, policy.source, rule.name) }
}

function approvalBody(f: PrFacts, source: string, rule: string) {
  const checks = f.requiredChecks.length ? `${f.requiredChecks.join(', ')} passed` : 'none set on this branch'
  return [
    `Approved by Kage under ${source}, rule "${rule}".`,
    '',
    `- Commit: ${short(f.sha)}`,
    `- Author: ${f.author}`,
    `- Pushed by: ${[...new Set(f.pushers ?? [])].join(', ')}`,
    `- Required checks: ${checks}`,
    `- Files: ${f.files.length}`,
  ].join('\n')
}

const TITLES: Record<Kind, (x: ApprovalVerdict) => string> = {
  approve: x => x.why, wait: () => 'Waiting on required checks', person: x => `Needs a person: ${x.why}`, stop: x => `Not approved: ${x.why}`, skip: x => x.why,
}

export type CheckRun = {
  name: string; head_sha: string; status: 'in_progress' | 'completed'; conclusion?: 'success' | 'neutral'
  output: { title: string; summary: string; text: string }
}

export function checkRun(policy: ApprovePolicy, f: PrFacts, x: ApprovalVerdict): CheckRun {
  const data = { verdict: x.kind, code: x.code, ...(x.rule && { rule: x.rule }), commit: f.sha, why: x.why, fix: x.fix, policy: policy.source }
  const summary = [x.why, ...(x.fix ? ['', `**Next:** ${x.fix}`] : []), '', `Policy: ${policy.source}`].join('\n')
  return {
    name: CHECK_NAME, head_sha: f.sha,
    ...(x.kind === 'wait' ? { status: 'in_progress' } : { status: 'completed', conclusion: x.kind === 'approve' ? 'success' : 'neutral' }),
    output: { title: TITLES[x.kind](x).slice(0, 200), summary, text: `\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\`` },
  }
}
