import { fixTask, fixVerdict, redVerdict, stuckEvent, type FixMode, type FixSeen, type StuckEvent, type StuckPull } from '../core/github-fix.ts'
import { ownerLines } from '../core/messages.ts'
import { log } from '../runtime/log.ts'
import type { GithubCall } from './github-app.ts'
import { commitChecks, requiredChecks } from './github-approve-read.ts'

type Seen = Record<string, FixSeen & { told?: true }>
type Options = {
  mode: FixMode; perPr: number; ownerId: number; ownerLogin: string; slug: string
  call: (installation: number) => GithubCall; allowed: (installation: number) => boolean
  seen: { load: () => Seen; save: (s: Seen) => void }
}
type RawPull = {
  number: number; title?: string; html_url?: string; state?: string; draft?: boolean; user?: { id?: number }; labels?: { name?: string }[]
  head: { sha: string; ref: string; repo?: { full_name?: string } | null }; base: { ref: string; repo?: { full_name?: string } }
}
type Closed = { action?: string; repository?: { full_name?: string }; pull_request?: { number?: number } }
export type FixStart = ReturnType<typeof fixTask> & { live: boolean; began: () => void; repo: string; number: number; installation: number }

const stuckPull = (p: RawPull): StuckPull => ({
  number: p.number, title: p.title ?? '', url: p.html_url ?? '', open: p.state === 'open', draft: p.draft === true,
  fromFork: p.head.repo?.full_name !== p.base.repo?.full_name, authorId: p.user?.id, sha: p.head.sha, branch: p.head.ref, base: p.base.ref,
  labels: (p.labels ?? []).map(l => l.name ?? ''),
})

type Judged = { at: string; pull: StuckPull; key: string; failing: string[] }
type Ctx = ReturnType<typeof context>

function context(o: Options) {
  const live = o.mode === 'on', seen: Seen = live ? o.seen.load() : {}
  return { o, live, seen, keep: () => { if (live) o.seen.save(seen) } }
}

function forget(c: Ctx, raw: unknown) {
  const p = (raw ?? {}) as Closed, at = `${p.repository?.full_name}#${p.pull_request?.number}`
  if (p.action === 'closed' && c.seen[at]) { delete c.seen[at]; c.keep() }
}

async function redOn(c: Ctx, call: GithubCall, repo: string, pull: StuckPull) {
  const [required, head, base] = await Promise.all([
    requiredChecks(call, repo, pull.base),
    commitChecks(call, repo, pull.sha, c.o.slug),
    commitChecks(call, repo, encodeURIComponent(pull.base), c.o.slug),
  ])
  return redVerdict(head.checks, { ref: pull.base, required: required.names, checks: base.checks })
}

async function tellSpent(c: Ctx, call: GithubCall, repo: string, n: number, was: Seen[string]) {
  if (was.told) return
  if (c.live) await call('POST', `/repos/${repo}/issues/${n}/comments`, { body: ownerLines.githubFixSpent(c.o.ownerLogin, was.tries) })
  else log(`github fix would tag @${c.o.ownerLogin} on ${repo}#${n} (shadow): out of fixes`)
  was.told = true
  c.keep()
}

async function judged(c: Ctx, call: GithubCall, e: StuckEvent, n: number): Promise<Judged | undefined> {
  const at = `${e.repo}#${n}`, pull = stuckPull(await call('GET', `/repos/${e.repo}/pulls/${n}`) as RawPull), was = c.seen[at]
  const v = fixVerdict(e, pull, c.o, was)
  if (!v.start && !v.spent) { log(`github fix skipped ${at}: ${v.why}`); return undefined }
  const red = e.reason === 'red checks' ? await redOn(c, call, e.repo, pull) : undefined
  if (red && !red.fix) { log(`github fix skipped ${at}: ${red.why}`); return undefined }
  if (!v.start) {
    log(`github fix skipped ${at}: ${v.why}`)
    if (was) await tellSpent(c, call, e.repo, n, was)
    return undefined
  }
  return { at, pull, key: v.key, failing: red?.fix ? red.failing : [] }
}

function start(c: Ctx, e: StuckEvent, j: Judged): FixStart {
  const began = () => {
    const was = c.seen[j.at]
    c.seen[j.at] = { keys: [...(was?.keys ?? []), j.key], tries: (was?.tries ?? 0) + 1 }
    c.keep()
    log(`github fix ${c.live ? 'starts' : 'would start (shadow)'} ${j.at}@${e.sha.slice(0, 7)}: ${e.reason}${j.failing.length ? ` (${j.failing.join(', ')})` : ''}`)
  }
  if (!c.live) began()
  return { ...fixTask(e, j.pull, j.failing, c.o.ownerLogin), live: c.live, began, repo: e.repo, number: j.pull.number, installation: e.installation }
}

export function fixer(o: Options) {
  const c = context(o)
  return {
    async handle(type: string, raw: unknown): Promise<FixStart[]> {
      if (type === 'pull_request') forget(c, raw)
      const e = stuckEvent(type, raw, o.slug)
      if (!e) return []
      if (!o.allowed(e.installation)) { log(`github fix dropped ${e.repo}: installation ${e.installation} is not allowed`); return [] }
      const call = o.call(e.installation), starts: FixStart[] = []
      const prs = e.prs.length ? e.prs : (await call('GET', `/repos/${e.repo}/commits/${e.sha}/pulls`) as { number: number }[]).map(p => p.number)
      for (const n of prs) {
        const j = await judged(c, call, e, n)
        if (j) starts.push(start(c, e, j))
      }
      return starts
    },
  }
}
