import { approvalEvent, approvalVerdict, type ApprovePolicy, type CheckResult, type PrFacts } from '../core/github-approve.ts'
import { ownerLines } from '../core/messages.ts'
import { log } from '../runtime/log.ts'
import type { GithubCall } from './github-app.ts'

type Options = { policy: ApprovePolicy; bot: string; call: (installation: number) => GithubCall; allowed: (installation: number) => boolean; notify: (text: string) => void }
type Pull = { number: number; state: string; draft?: boolean; user: { login: string }; html_url: string; head: { sha: string; repo: { full_name: string } | null }; base: { ref: string; repo: { full_name: string } } }
type Branch = { protected?: boolean; protection?: { required_status_checks?: { contexts?: string[] } } }
type Run = { id: number; name: string; status: string; conclusion: string | null }
type Review = { id: number; state: string; commit_id: string; user: { login: string } | null }

const PASS = new Set(['success', 'neutral', 'skipped'])
const FILE_PAGES = 30
const runResult = (r: Run): CheckResult => r.status !== 'completed' ? 'pending' : PASS.has(r.conclusion ?? '') ? 'pass' : 'fail'
const statusResult = (state: string): CheckResult => state === 'success' ? 'pass' : state === 'pending' ? 'pending' : 'fail'

async function changedFiles(call: GithubCall, repo: string, n: number) {
  const names: string[] = []
  for (let page = 1; page <= FILE_PAGES; page++) {
    const batch = await call('GET', `/repos/${repo}/pulls/${n}/files?per_page=100&page=${page}`) as { filename: string; previous_filename?: string }[]
    for (const f of batch) names.push(f.filename, ...(f.previous_filename ? [f.previous_filename] : []))
    if (batch.length < 100) break
  }
  return names
}

async function commitChecks(call: GithubCall, repo: string, sha: string) {
  const [runs, status] = await Promise.all([
    call('GET', `/repos/${repo}/commits/${sha}/check-runs?per_page=100`) as Promise<{ check_runs: Run[] }>,
    call('GET', `/repos/${repo}/commits/${sha}/status`) as Promise<{ statuses: { context: string; state: string }[] }>,
  ])
  const latest = new Map<string, CheckResult>()
  for (const r of [...runs.check_runs].sort((a, b) => b.id - a.id)) if (!latest.has(r.name)) latest.set(r.name, runResult(r))
  for (const s of status.statuses) if (!latest.has(s.context)) latest.set(s.context, statusResult(s.state))
  return [...latest].map(([name, result]) => ({ name, result }))
}

async function readPull(call: GithubCall, repo: string, n: number, bot: string) {
  const pull = await call('GET', `/repos/${repo}/pulls/${n}`) as Pull
  const sha = pull.head.sha
  const [branch, files, checks, reviews] = await Promise.all([
    call('GET', `/repos/${repo}/branches/${encodeURIComponent(pull.base.ref)}`) as Promise<Branch>,
    changedFiles(call, repo, n),
    commitChecks(call, repo, sha),
    call('GET', `/repos/${repo}/pulls/${n}/reviews?per_page=100`) as Promise<Review[]>,
  ])
  const mine = reviews.filter(r => r.user?.login === bot && r.state === 'APPROVED')
  const facts: PrFacts = {
    repo, number: n, sha, author: pull.user.login, open: pull.state === 'open', draft: pull.draft === true,
    fromFork: pull.head.repo?.full_name !== pull.base.repo.full_name, baseProtected: branch.protected === true,
    requiredChecks: branch.protection?.required_status_checks?.contexts ?? [], checks, files, approvedShas: mine.map(r => r.commit_id),
  }
  return { facts, url: pull.html_url, stale: mine.filter(r => r.commit_id !== sha).map(r => r.id) }
}

export function approver(o: Options) {
  const told = new Set<string>()
  const checkOne = async (call: GithubCall, repo: string, n: number) => {
    const { facts, url, stale } = await readPull(call, repo, n, o.bot)
    const v = approvalVerdict(o.policy, facts), sha = facts.sha.slice(0, 7)
    log(`github approve ${repo}#${n}@${sha}: ${v.kind}${v.kind === 'approve' ? '' : ` (${v.why})`}`)
    if (v.kind === 'approve') return void await call('POST', `/repos/${repo}/pulls/${n}/reviews`, { commit_id: facts.sha, event: 'APPROVE', body: v.body })
    if (facts.open) for (const id of stale) await call('PUT', `/repos/${repo}/pulls/${n}/reviews/${id}/dismissals`, { event: 'DISMISS', message: `Kage has not approved the new commit ${sha} yet.` })
    const key = `${repo}#${n}@${facts.sha}`
    if (v.kind === 'human' && !told.has(key)) { told.add(key); o.notify(ownerLines.githubNeedsPerson(v.why, url)) }
  }
  return {
    async handle(type: string, raw: unknown) {
      const e = approvalEvent(type, raw)
      if (!e) return false
      if (!o.allowed(e.installation)) { log(`github approve dropped ${e.repo}: installation ${e.installation} is not allowed`); return false }
      const call = o.call(e.installation)
      const prs = 'prs' in e ? e.prs : (await call('GET', `/repos/${e.repo}/commits/${e.sha}/pulls`) as { number: number }[]).map(p => p.number)
      for (const n of prs) await checkOne(call, e.repo, n)
      return prs.length > 0
    },
  }
}
