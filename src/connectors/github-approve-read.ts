import { CHECK_NAME, ORG_POLICY, REPO_POLICY, type CheckResult, type PrFacts } from '../core/github-approve.ts'
import { onlyVersionChanges, parsePolicy, type ChangedFile } from '../core/github-policy.ts'
import { GithubRefused, type GithubCall } from './github-app.ts'

type Pull = {
  number: number; state: string; draft?: boolean; user: { login: string }; html_url: string; additions?: number; deletions?: number
  head: { sha: string; ref: string; repo: { full_name: string } | null }; base: { ref: string; repo: { full_name: string } }
  labels?: { name: string }[]
}
type Branch = { protected?: boolean; protection?: { required_status_checks?: { contexts?: string[] } } }
type Run = { id: number; name: string; status: string; conclusion: string | null; app?: { slug?: string }; output?: { title?: string | null } }
type Review = { id: number; state: string; commit_id: string; user: { login: string } | null }
type Activity = { activity_type: string; actor: { login: string } | null; after?: string }
type BranchRule = { type: string; parameters?: { required_status_checks?: { context: string }[] } }
export type OwnRun = { id: number; status: string; conclusion: string | null; title: string }

const PASS = new Set(['success', 'neutral', 'skipped'])
const MAX_PAGES = 30
const runResult = (r: Run): CheckResult => r.status !== 'completed' ? 'pending' : PASS.has(r.conclusion ?? '') ? 'pass' : 'fail'
const statusResult = (state: string): CheckResult => state === 'success' ? 'pass' : state === 'pending' ? 'pending' : 'fail'

export async function pages<T>(call: GithubCall, path: string, pick: (body: unknown) => T[] = b => b as T[]) {
  const all: T[] = []
  const join = path.includes('?') ? '&' : '?'
  for (let page = 1; page <= MAX_PAGES; page++) {
    const batch = pick(await call('GET', `${path}${join}per_page=100&page=${page}`))
    all.push(...batch)
    if (batch.length < 100) return { all, cut: false }
  }
  return { all, cut: true }
}

async function changedFiles(call: GithubCall, repo: string, n: number) {
  const { all, cut } = await pages<ChangedFile>(call, `/repos/${repo}/pulls/${n}/files`)
  return { names: all.flatMap(f => [f.filename, ...(f.previous_filename ? [f.previous_filename] : [])]), cut, versionOnly: !cut && onlyVersionChanges(all) }
}

async function commitChecks(call: GithubCall, repo: string, sha: string, slug: string) {
  const [runs, status] = await Promise.all([
    pages<Run>(call, `/repos/${repo}/commits/${sha}/check-runs`, b => (b as { check_runs: Run[] }).check_runs),
    call('GET', `/repos/${repo}/commits/${sha}/status`) as Promise<{ statuses: { context: string; state: string }[] }>,
  ])
  const newest = [...runs.all].sort((a, b) => b.id - a.id)
  const own = newest.find(r => r.name === CHECK_NAME && r.app?.slug === slug)
  const latest = new Map<string, CheckResult>()
  for (const r of newest) if (r.name !== CHECK_NAME && !latest.has(r.name)) latest.set(r.name, runResult(r))
  for (const s of status.statuses) if (!latest.has(s.context)) latest.set(s.context, statusResult(s.state))
  return {
    checks: [...latest].map(([name, result]) => ({ name, result })),
    own: own && { id: own.id, status: own.status, conclusion: own.conclusion, title: own.output?.title ?? '' },
  }
}

async function branchPushers(call: GithubCall, repo: string, branch: string, head: string) {
  const seen = await call('GET', `/repos/${repo}/activity?ref=${encodeURIComponent(`refs/heads/${branch}`)}&per_page=100`) as Activity[]
  const upTo = seen.findIndex(a => a.activity_type === 'branch_creation')
  if (upTo < 0) return { pushers: undefined, headPushed: false }
  const acts = seen.slice(0, upTo + 1)
  return { pushers: acts.every(a => a.actor) ? acts.map(a => a.actor!.login) : undefined, headPushed: acts.some(a => a.after === head) }
}

async function requiredChecks(call: GithubCall, repo: string, base: string) {
  const [branch, rules] = await Promise.all([
    call('GET', `/repos/${repo}/branches/${encodeURIComponent(base)}`) as Promise<Branch>,
    pages<BranchRule>(call, `/repos/${repo}/rules/branches/${encodeURIComponent(base)}`),
  ])
  const fromRules = rules.all.filter(r => r.type === 'required_status_checks').flatMap(r => r.parameters?.required_status_checks?.map(c => c.context) ?? [])
  const names = [...new Set([...(branch.protection?.required_status_checks?.contexts ?? []), ...fromRules])]
  return { protected: branch.protected === true, names: names.filter(name => name !== CHECK_NAME) }
}

async function fileText(call: GithubCall, repo: string, path: string, ref?: string) {
  try {
    const got = await call('GET', `/repos/${repo}/contents/${path}${ref ? `?ref=${encodeURIComponent(ref)}` : ''}`) as { content?: string }
    return Buffer.from(got.content ?? '', 'base64').toString('utf8')
  } catch (e) {
    if (e instanceof GithubRefused && e.status === 404) return undefined
    throw e
  }
}

export async function loadPolicy(call: GithubCall, repo: string, base: string, policyRepo: string) {
  const own = await fileText(call, repo, REPO_POLICY, base)
  const orgRepo = `${repo.split('/')[0]}/${policyRepo}`
  const [text, source] = own !== undefined ? [own, `${repo} ${REPO_POLICY}`] : [await fileText(call, orgRepo, ORG_POLICY), `${orgRepo} ${ORG_POLICY}`]
  return text === undefined ? undefined : { policy: parsePolicy(text, source), text, source }
}

export async function kageApprovals(call: GithubCall, repo: string, n: number, bot: string) {
  const reviews = await pages<Review>(call, `/repos/${repo}/pulls/${n}/reviews`)
  return reviews.all.filter(r => r.user?.login === bot && r.state === 'APPROVED').map(r => ({ id: r.id, sha: r.commit_id }))
}

export async function readPull(call: GithubCall, repo: string, n: number, slug: string) {
  const pull = await call('GET', `/repos/${repo}/pulls/${n}`) as Pull
  const sha = pull.head.sha
  const [required, files, checks, approvals, pushes] = await Promise.all([
    requiredChecks(call, repo, pull.base.ref),
    changedFiles(call, repo, n),
    commitChecks(call, repo, sha, slug),
    kageApprovals(call, repo, n, `${slug}[bot]`),
    branchPushers(call, repo, pull.head.ref, sha),
  ])
  const moved = (await call('GET', `/repos/${repo}/pulls/${n}`) as Pull).head.sha !== sha
  const facts: PrFacts = {
    repo, number: n, sha, author: pull.user.login, base: pull.base.ref, branch: pull.head.ref,
    open: pull.state === 'open', draft: pull.draft === true, fromFork: pull.head.repo?.full_name !== pull.base.repo.full_name,
    baseProtected: required.protected, requiredChecks: required.names,
    checks: checks.checks, files: files.names, filesCut: files.cut, versionOnly: files.versionOnly, lines: (pull.additions ?? 0) + (pull.deletions ?? 0), ...pushes,
    labels: (pull.labels ?? []).map(l => l.name),
  }
  return { facts, moved, url: pull.html_url, approvals, own: checks.own }
}
