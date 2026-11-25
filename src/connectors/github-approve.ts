import { approvalEvent, approvalVerdict, type ApprovePolicy, type CheckResult, type PrFacts } from '../core/github-approve.ts'
import { ownerLines } from '../core/messages.ts'
import { log } from '../runtime/log.ts'
import type { GithubCall } from './github-app.ts'

type Settle = { ms: number; now: () => number; later: (ms: number, run: () => void) => () => void }
type Options = { policy: ApprovePolicy; bot: string; call: (installation: number) => GithubCall; allowed: (installation: number) => boolean; notify: (text: string) => void; settle?: Settle }

export const quietTimer: Settle['later'] = (ms, run) => { const t = setTimeout(run, ms); t.unref(); return () => clearTimeout(t) }
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
  return { facts, moved, url: pull.html_url, stale: mine.filter(r => r.commit_id !== sha).map(r => r.id) }
}

export function approver(o: Options) {
  const told = new Set<string>()
  const settle = o.settle ?? { ms: 0, now: Date.now, later: quietTimer }
  const seen = new Map<string, { sha: string; at: number }>(), waiting = new Map<string, () => void>()
  let chain: Promise<unknown> = Promise.resolve()
  const queued = (job: () => Promise<void>) => { const next = chain.then(job); chain = next.catch(e => log('github approve failed', e)); return next }
  const quietLeft = (pr: string, sha: string) => {
    const at = seen.get(pr)?.sha === sha ? seen.get(pr)!.at : settle.now()
    seen.set(pr, { sha, at })
    return Math.max(0, at + settle.ms - settle.now())
  }
  const waitThenCheck = (call: GithubCall, repo: string, n: number, ms: number) => {
    const pr = `${repo}#${n}`
    waiting.get(pr)?.()
    waiting.set(pr, settle.later(ms, () => { waiting.delete(pr); void queued(() => checkOne(call, repo, n)) }))
  }
  const checkOne = async (call: GithubCall, repo: string, n: number) => {
    const { facts, moved, url, stale } = await readPull(call, repo, n, o.bot)
    const sha = facts.sha.slice(0, 7)
    if (moved) return void log(`github approve ${repo}#${n}@${sha}: skip (a newer commit landed while Kage read this one)`)
    const v = approvalVerdict(o.policy, facts)
    const left = v.kind === 'approve' ? quietLeft(`${repo}#${n}`, facts.sha) : 0
    log(`github approve ${repo}#${n}@${sha}: ${v.kind === 'approve' && left ? `approve in ${Math.ceil(left / 1000)} s, once no newer commit lands` : v.kind}${v.kind === 'approve' ? '' : ` (${v.why})`}`)
    if (v.kind === 'approve' && !left) { seen.delete(`${repo}#${n}`); return void await call('POST', `/repos/${repo}/pulls/${n}/reviews`, { commit_id: facts.sha, event: 'APPROVE', body: v.body }) }
    if (v.kind === 'approve') waitThenCheck(call, repo, n, left)
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
      for (const n of prs) await queued(() => checkOne(call, e.repo, n))
      return prs.length > 0
    },
    idle: () => chain,
  }
}
