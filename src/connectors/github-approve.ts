import { createHash } from 'node:crypto'
import { approvalEvent, approvalVerdict, checkRun, type ApprovalVerdict, type CheckRun } from '../core/github-approve.ts'
import type { ApprovePolicy } from '../core/github-policy.ts'
import { ownerLines } from '../core/messages.ts'
import { log } from '../runtime/log.ts'
import { GithubRefused, type GithubCall } from './github-app.ts'
import { kageApprovals, loadPolicy, pages, readPull, type OwnRun } from './github-approve-read.ts'

type Seen = Record<string, string>
type Options = {
  policyRepo: string; slug: string; call: (installation: number) => GithubCall; allowed: (installation: number) => boolean
  notify: (text: string) => void; queue: (job: () => Promise<unknown>) => void
  seen?: { load: () => Seen; save: (s: Seen) => void }; now?: () => number
}
type Listed = { number: number; draft?: boolean; user: { login: string }; head: { sha: string }; base: { ref: string } }
const SETTLED = new Set(['person', 'stop', 'skip'])
const SEEN_MS = 86_400_000
const digest = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 12)
const seenKey = (sha: string, policyText: string, draft: boolean, base: string) => `${sha}:${digest(policyText)}:${draft ? 'draft' : 'ready'}:${base}`

function checkWriter(o: Options) {
  let told = false
  return async (call: GithubCall, repo: string, run: CheckRun, own: OwnRun | undefined) => {
    if (own && own.status === run.status && own.conclusion === (run.conclusion ?? null) && own.title === run.output.title) return
    const { name: _name, head_sha: _sha, ...change } = run
    const reopens = own?.status === 'completed' && run.status !== 'completed'
    try {
      if (own && !reopens) await call('PATCH', `/repos/${repo}/check-runs/${own.id}`, change)
      else await call('POST', `/repos/${repo}/check-runs`, run)
    } catch (e) {
      if (!(e instanceof GithubRefused && e.status === 403)) throw e
      log(`github approve: GitHub refused the Kage policy check on ${repo} (403), so Kage approves without it`)
      if (!told) { told = true; o.notify(ownerLines.githubChecksDenied()) }
    }
  }
}

type Ctx = ReturnType<typeof context>

function context(o: Options) {
  const told = new Set<string>(), policies = new Map<string, string>(), seen: Seen = o.seen?.load() ?? {}
  const ctx = {
    o, bot: `${o.slug}[bot]`, writeCheck: checkWriter(o), found: undefined as string[] | undefined,
    remember(repo: string, n: number, key: string) { seen[`${repo}#${n}`] = `${key}|${(o.now ?? Date.now)()}`; o.seen?.save(seen) },
    judged(repo: string, n: number, key: string) {
      const [was, at] = (seen[`${repo}#${n}`] ?? '').split('|')
      return was === key && (o.now ?? Date.now)() - Number(at) < SEEN_MS
    },
    forgetClosed(repo: string, open: Set<number>) {
      for (const k of Object.keys(seen)) if (k.startsWith(`${repo}#`) && !open.has(Number(k.slice(repo.length + 1)))) delete seen[k]
      o.seen?.save(seen)
    },
    once(key: string) { const first = !told.has(key); told.add(key); return first },
    tell(key: string, text: string) { if (ctx.once(key)) o.notify(text) },
    async dismiss(call: GithubCall, repo: string, n: number, ids: number[], sha: string) {
      for (const id of ids) await call('PUT', `/repos/${repo}/pulls/${n}/reviews/${id}/dismissals`, { event: 'DISMISS', message: `Kage does not approve commit ${sha.slice(0, 7)}. The Kage policy check says why.` })
    },
    policyChanged(installation: number, source: string, text: string) {
      const before = policies.get(source)
      policies.set(source, text)
      if (before !== undefined && before !== text) o.queue(() => sweep(ctx, installation))
    },
  }
  return ctx
}

async function act(ctx: Ctx, call: GithubCall, read: Awaited<ReturnType<typeof readPull>>, policy: ApprovePolicy, x: ApprovalVerdict, mayApprove: boolean) {
  const { facts: f, approvals, url } = read
  if (x.kind === 'approve' && mayApprove && !approvals.some(a => a.sha === f.sha)) await call('POST', `/repos/${f.repo}/pulls/${f.number}/reviews`, { commit_id: f.sha, event: 'APPROVE', body: x.body })
  if (x.kind !== 'skip') await ctx.writeCheck(call, f.repo, checkRun(policy, f, x), read.own)
  const once = x.kind === 'person' && ctx.once(`${f.repo}#${f.number}@${f.sha}`)
  if (once && ctx.found) ctx.found.push(`${f.repo}#${f.number}: ${x.why} ${url}`)
  else if (once) ctx.o.notify(ownerLines.githubNeedsPerson(`${f.repo}#${f.number}: ${x.why}`, url))
  const drop = x.kind === 'approve' || x.kind === 'ready' ? [] : approvals.filter(a => x.kind !== 'wait' || a.sha !== f.sha)
  if (f.open) await ctx.dismiss(call, f.repo, f.number, drop.map(a => a.id), f.sha)
}

async function checkOne(ctx: Ctx, installation: number, call: GithubCall, repo: string, n: number, mayApprove = true) {
  const read = await readPull(call, repo, n, ctx.o.slug)
  const { facts: f } = read, sha = f.sha.slice(0, 7)
  if (read.moved) return void log(`github approve ${repo}#${n}@${sha}: skip (a newer commit landed while Kage read this one)`)
  const loaded = await loadPolicy(call, repo, f.base, ctx.o.policyRepo)
  if (!loaded) return void log(`github approve ${repo}#${n}@${sha}: skip (no policy file)`)
  ctx.policyChanged(installation, `${loaded.source}@${f.base}`, loaded.text)
  if ('error' in loaded.policy) { log(`github approve: bad policy, ${loaded.policy.error}`); return ctx.tell(loaded.policy.error, ownerLines.githubBadPolicy(loaded.policy.error)) }
  const x = approvalVerdict(loaded.policy, f)
  log(`github approve ${repo}#${n}@${sha}: ${x.kind} ${x.code}${x.kind === 'approve' ? '' : ` (${x.why})`}`)
  await act(ctx, call, read, loaded.policy, x, mayApprove)
  if (SETTLED.has(x.kind) && x.code !== 'checks-failed') ctx.remember(repo, n, seenKey(f.sha, loaded.text, f.draft, f.base))
}

async function leftAlone(ctx: Ctx, call: GithubCall, repo: string, pr: Listed, policyText: string, approvals: { id: number }[]) {
  await ctx.dismiss(call, repo, pr.number, approvals.map(a => a.id), pr.head.sha)
  ctx.remember(repo, pr.number, seenKey(pr.head.sha, policyText, pr.draft === true, pr.base.ref))
}

async function sweepRepo(ctx: Ctx, installation: number, call: GithubCall, repo: string) {
  const open = (await pages<Listed>(call, `/repos/${repo}/pulls?state=open`)).all
  const policyAt = new Map<string, Awaited<ReturnType<typeof loadPolicy>>>()
  for (const pr of open) {
    if (!policyAt.has(pr.base.ref)) policyAt.set(pr.base.ref, await loadPolicy(call, repo, pr.base.ref, ctx.o.policyRepo))
    const loaded = policyAt.get(pr.base.ref)
    if (!loaded || 'error' in loaded.policy || ctx.judged(repo, pr.number, seenKey(pr.head.sha, loaded.text, pr.draft === true, pr.base.ref))) continue
    try {
      const listed = loaded.policy.people.includes(pr.user.login.toLowerCase())
      const approvals = await kageApprovals(call, repo, pr.number, ctx.bot)
      if (listed && approvals.length) await checkOne(ctx, installation, call, repo, pr.number, false)
      else await leftAlone(ctx, call, repo, pr, loaded.text, approvals)
    } catch (e) { log(`github approve sweep ${repo}#${pr.number} failed`, e) }
  }
  ctx.forgetClosed(repo, new Set(open.map(pr => pr.number)))
}

async function sweep(ctx: Ctx, installation: number) {
  if (!ctx.o.allowed(installation)) return
  const call = ctx.o.call(installation)
  ctx.found = []
  try { await sweepRepos(ctx, installation, call) } finally {
    if (ctx.found.length) ctx.o.notify(ownerLines.githubSweepNeedsPerson(ctx.found))
    ctx.found = undefined
  }
}

async function sweepRepos(ctx: Ctx, installation: number, call: GithubCall) {
  const repos = (await pages<{ full_name: string; archived?: boolean }>(call, '/installation/repositories', b => (b as { repositories: { full_name: string; archived?: boolean }[] }).repositories)).all
  for (const r of repos.filter(r => !r.archived)) {
    try { await sweepRepo(ctx, installation, call, r.full_name) } catch (e) { log(`github approve sweep ${r.full_name} failed`, e) }
  }
  log(`github approve: checked the open pull requests of ${repos.length} repos on installation ${installation}`)
}

export function approver(o: Options) {
  const ctx = context(o)
  return {
    sweep: (installation: number) => sweep(ctx, installation),
    async handle(type: string, raw: unknown) {
      const e = approvalEvent(type, raw, o.slug)
      if (!e) return false
      if (!o.allowed(e.installation)) { log(`github approve dropped ${e.repo}: installation ${e.installation} is not allowed`); return false }
      const call = o.call(e.installation)
      const prs = 'prs' in e ? e.prs : (await call('GET', `/repos/${e.repo}/commits/${e.sha}/pulls`) as { number: number }[]).map(p => p.number)
      for (const n of prs) await checkOne(ctx, e.installation, call, e.repo, n)
      return prs.length > 0
    },
  }
}
