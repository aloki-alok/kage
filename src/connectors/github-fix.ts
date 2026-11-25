import { fixTask, fixVerdict, stillRed, stuckEvent, type FixMode, type FixSeen, type StuckEvent, type StuckPull } from '../core/github-fix.ts'
import { ownerLines } from '../core/messages.ts'
import { log } from '../runtime/log.ts'
import type { GithubCall } from './github-app.ts'

type Seen = Record<string, FixSeen & { told?: true }>
type Waiting = Record<string, { e: StuckEvent; n: number; due: number }>
type Options = {
  mode: FixMode; perPr: number; graceMinutes: number; ownerId: number; slug: string; now?: () => number
  call: (installation: number) => GithubCall; allowed: (installation: number) => boolean; notify: (text: string) => void
  seen: { load: () => Seen; save: (s: Seen) => void }
  waiting: { load: () => Waiting; save: (w: Waiting) => void }
}
type RawPull = {
  number: number; title?: string; html_url?: string; state?: string; draft?: boolean; user?: { id?: number }; labels?: { name?: string }[]
  head: { sha: string; ref: string; repo?: { full_name?: string } | null }; base: { repo?: { full_name?: string } }
}
type Closed = { action?: string; repository?: { full_name?: string }; pull_request?: { number?: number } }
export type FixStart = ReturnType<typeof fixTask> & { live: boolean; began: () => void }

const GIVE_UP_MS = 3_600_000
const stuckPull = (p: RawPull): StuckPull => ({
  number: p.number, title: p.title ?? '', url: p.html_url ?? '', open: p.state === 'open', draft: p.draft === true,
  fromFork: p.head.repo?.full_name !== p.base.repo?.full_name, authorId: p.user?.id, sha: p.head.sha, branch: p.head.ref,
  labels: (p.labels ?? []).map(l => l.name ?? ''),
})

type Judged = { at: string; pull: StuckPull; key: string }
type Ctx = ReturnType<typeof context>

function context(o: Options) {
  const live = o.mode === 'on', seen: Seen = live ? o.seen.load() : {}, waiting: Waiting = live ? o.waiting.load() : {}
  return {
    o, live, seen, waiting, now: o.now ?? Date.now, graceMs: o.graceMinutes * 60_000,
    keep: () => { if (live) o.seen.save(seen) },
    keepWaiting: () => { if (live) o.waiting.save(waiting) },
  }
}

function forget(c: Ctx, raw: unknown) {
  const p = (raw ?? {}) as Closed, at = `${p.repository?.full_name}#${p.pull_request?.number}`
  if (p.action !== 'closed') return
  if (c.seen[at]) { delete c.seen[at]; c.keep() }
  const gone = Object.keys(c.waiting).filter(k => k.startsWith(`${at}|`))
  for (const k of gone) delete c.waiting[k]
  if (gone.length) c.keepWaiting()
}

async function judged(c: Ctx, call: GithubCall, e: StuckEvent, n: number): Promise<Judged | undefined> {
  const at = `${e.repo}#${n}`, pull = stuckPull(await call('GET', `/repos/${e.repo}/pulls/${n}`) as RawPull), was = c.seen[at]
  const v = fixVerdict(e, pull, c.o, was)
  if (v.start) return { at, pull, key: v.key }
  log(`github fix skipped ${at}: ${v.why}`)
  if (v.spent && was && !was.told) { was.told = true; c.keep(); c.o.notify(ownerLines.githubFixSpent(at, was.tries, pull.url)) }
  return undefined
}

function start(c: Ctx, e: StuckEvent, j: Judged): FixStart {
  const began = () => {
    const was = c.seen[j.at]
    c.seen[j.at] = { keys: [...(was?.keys ?? []), j.key], tries: (was?.tries ?? 0) + 1 }
    c.keep()
    log(`github fix ${c.live ? 'starts' : 'would start (shadow)'} ${j.at}@${e.sha.slice(0, 7)}: ${e.reason}`)
  }
  if (!c.live) began()
  return { ...fixTask(e, j.pull), live: c.live, began }
}

async function afterWait(c: Ctx, k: string): Promise<FixStart | undefined> {
  const { e, n } = c.waiting[k]!, call = c.o.call(e.installation)
  const j = await judged(c, call, e, n)
  if (!j) return undefined
  if (e.reason === 'red checks') {
    const got = await call('GET', `/repos/${e.repo}/commits/${e.sha}/check-suites?per_page=100`) as { check_suites?: Parameters<typeof stillRed>[0] }
    if (!stillRed(got.check_suites ?? [], c.o.slug)) { log(`github fix skipped ${j.at}: its checks are no longer red`); return undefined }
  }
  return start(c, e, j)
}

async function heard(c: Ctx, e: StuckEvent): Promise<FixStart[]> {
  const call = c.o.call(e.installation), starts: FixStart[] = []
  const prs = e.prs.length ? e.prs : (await call('GET', `/repos/${e.repo}/commits/${e.sha}/pulls`) as { number: number }[]).map(p => p.number)
  for (const n of prs) {
    const j = await judged(c, call, e, n)
    if (!j) continue
    if (!c.graceMs) { starts.push(start(c, e, j)); continue }
    const k = `${j.at}|${j.key}`
    if (c.waiting[k]) continue
    c.waiting[k] = { e, n, due: c.now() + c.graceMs }
    c.keepWaiting()
    log(`github fix waits ${c.o.graceMinutes} min on ${j.at}@${e.sha.slice(0, 7)}: ${e.reason}`)
  }
  return starts
}

export function fixer(o: Options) {
  const c = context(o)
  return {
    async handle(type: string, raw: unknown): Promise<FixStart[]> {
      if (type === 'pull_request') forget(c, raw)
      const e = stuckEvent(type, raw, o.slug)
      if (!e) return []
      if (!o.allowed(e.installation)) { log(`github fix dropped ${e.repo}: installation ${e.installation} is not allowed`); return [] }
      return heard(c, e)
    },
    async due(): Promise<FixStart[]> {
      const starts: FixStart[] = []
      for (const k of Object.keys(c.waiting).filter(k => c.waiting[k]!.due <= c.now())) {
        try {
          const s = await afterWait(c, k)
          if (s) starts.push(s)
        } catch (err) {
          log(`github fix could not check ${k.split('|')[0]} after its wait`, err)
          if (c.now() <= c.waiting[k]!.due + GIVE_UP_MS) continue
        }
        delete c.waiting[k]
        c.keepWaiting()
      }
      return starts
    },
  }
}
