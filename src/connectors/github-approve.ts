import { approvalEvent, approvalVerdict, ORG_POLICY, parsePolicy, REPO_POLICY, type CheckResult, type PrFacts } from '../core/github-approve.ts'
import { ownerLines } from '../core/messages.ts'
import { log } from '../runtime/log.ts'
import { GithubRefused, type GithubCall } from './github-app.ts'

type Options = { policyRepo: string; bot: string; call: (installation: number) => GithubCall; allowed: (installation: number) => boolean; notify: (text: string) => void }
type Pull = { number: number; state: string; draft?: boolean; user: { login: string }; html_url: string; head: { sha: string; repo: { full_name: string } | null }; base: { ref: string; repo: { full_name: string } } }
type Branch = { protected?: boolean; protection?: { required_status_checks?: { contexts?: string[] } } }
type Run = { id: number; name: string; status: string; conclusion: string | null }
type Review = { id: number; state: string; commit_id: string; user: { login: string } | null }

const PASS = new Set(['success', 'neutral', 'skipped'])
const MAX_PAGES = 30
const runResult = (r: Run): CheckResult => r.status !== 'completed' ? 'pending' : PASS.has(r.conclusion ?? '') ? 'pass' : 'fail'
const statusResult = (state: string): CheckResult => state === 'success' ? 'pass' : state === 'pending' ? 'pending' : 'fail'

async function pages<T>(call: GithubCall, path: string, pick: (body: unknown) => T[] = b => b as T[]) {
  const all: T[] = []
  for (let page = 1; page <= MAX_PAGES; page++) {
    const batch = pick(await call('GET', `${path}?per_page=100&page=${page}`))
    all.push(...batch)
    if (batch.length < 100) return { all, cut: false }
  }
  return { all, cut: true }
}

async function changedFiles(call: GithubCall, repo: string, n: number) {
  const { all, cut } = await pages<{ filename: string; previous_filename?: string }>(call, `/repos/${repo}/pulls/${n}/files`)
  return { names: all.flatMap(f => [f.filename, ...(f.previous_filename ? [f.previous_filename] : [])]), cut }
}

async function commitChecks(call: GithubCall, repo: string, sha: string) {
  const [runs, status] = await Promise.all([
    pages<Run>(call, `/repos/${repo}/commits/${sha}/check-runs`, b => (b as { check_runs: Run[] }).check_runs),
    call('GET', `/repos/${repo}/commits/${sha}/status`) as Promise<{ statuses: { context: string; state: string }[] }>,
  ])
  const latest = new Map<string, CheckResult>()
  for (const r of [...runs.all].sort((a, b) => b.id - a.id)) if (!latest.has(r.name)) latest.set(r.name, runResult(r))
  for (const s of status.statuses) if (!latest.has(s.context)) latest.set(s.context, statusResult(s.state))
  return [...latest].map(([name, result]) => ({ name, result }))
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

async function loadPolicy(call: GithubCall, repo: string, base: string, policyRepo: string) {
  const own = await fileText(call, repo, REPO_POLICY, base)
  if (own !== undefined) return parsePolicy(own, `${repo} ${REPO_POLICY}`)
  const orgRepo = `${repo.split('/')[0]}/${policyRepo}`
  const org = await fileText(call, orgRepo, ORG_POLICY)
  return org === undefined ? undefined : parsePolicy(org, `${orgRepo} ${ORG_POLICY}`)
}

async function readPull(call: GithubCall, repo: string, n: number, bot: string) {
  const pull = await call('GET', `/repos/${repo}/pulls/${n}`) as Pull
  const sha = pull.head.sha
  const [branch, files, checks, reviews] = await Promise.all([
    call('GET', `/repos/${repo}/branches/${encodeURIComponent(pull.base.ref)}`) as Promise<Branch>,
    changedFiles(call, repo, n),
    commitChecks(call, repo, sha),
    pages<Review>(call, `/repos/${repo}/pulls/${n}/reviews`),
  ])
  const moved = (await call('GET', `/repos/${repo}/pulls/${n}`) as Pull).head.sha !== sha
  const mine = reviews.all.filter(r => r.user?.login === bot && r.state === 'APPROVED')
  const facts: PrFacts = {
    repo, number: n, sha, author: pull.user.login, open: pull.state === 'open', draft: pull.draft === true,
    fromFork: pull.head.repo?.full_name !== pull.base.repo.full_name, baseProtected: branch.protected === true,
    requiredChecks: branch.protection?.required_status_checks?.contexts ?? [], checks, files: files.names, filesCut: files.cut, approvedShas: mine.map(r => r.commit_id),
  }
  return { facts, moved, base: pull.base.ref, url: pull.html_url, stale: mine.filter(r => r.commit_id !== sha).map(r => r.id) }
}

export function approver(o: Options) {
  const told = new Set<string>()
  const badPolicy = (error: string) => {
    log(`github approve: bad policy, ${error}`)
    if (!told.has(error)) { told.add(error); o.notify(ownerLines.githubBadPolicy(error)) }
  }
  const checkOne = async (call: GithubCall, repo: string, n: number) => {
    const { facts, moved, base, url, stale } = await readPull(call, repo, n, o.bot)
    const sha = facts.sha.slice(0, 7)
    if (moved) return void log(`github approve ${repo}#${n}@${sha}: skip (a newer commit landed while Kage read this one)`)
    const policy = await loadPolicy(call, repo, base, o.policyRepo)
    if (!policy) return void log(`github approve ${repo}#${n}@${sha}: skip (no ${REPO_POLICY} here and no org ${ORG_POLICY})`)
    if ('error' in policy) return badPolicy(policy.error)
    const v = approvalVerdict(policy, facts)
    log(`github approve ${repo}#${n}@${sha}: ${v.kind}${v.kind === 'approve' ? '' : ` (${v.why})`}`)
    if (v.kind === 'approve') return void await call('POST', `/repos/${repo}/pulls/${n}/reviews`, { commit_id: facts.sha, event: 'APPROVE', body: v.body })
    const key = `${repo}#${n}@${facts.sha}`
    if (v.kind === 'human' && !told.has(key)) { told.add(key); o.notify(ownerLines.githubNeedsPerson(v.why, url)) }
    if (facts.open) for (const id of stale) await call('PUT', `/repos/${repo}/pulls/${n}/reviews/${id}/dismissals`, { event: 'DISMISS', message: `Kage has not approved the new commit ${sha} yet.` })
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
