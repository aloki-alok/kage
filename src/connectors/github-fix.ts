import { fixTask, fixVerdict, stuckEvent, type FixMode, type FixSeen, type StuckPull } from '../core/github-fix.ts'
import { ownerLines } from '../core/messages.ts'
import { log } from '../runtime/log.ts'
import type { GithubCall } from './github-app.ts'

type Seen = Record<string, FixSeen & { told?: true }>
type Options = {
  mode: FixMode; perPr: number; ownerId: number; slug: string
  call: (installation: number) => GithubCall; allowed: (installation: number) => boolean; notify: (text: string) => void
  seen: { load: () => Seen; save: (s: Seen) => void }
}
type RawPull = {
  number: number; title?: string; html_url?: string; state?: string; draft?: boolean; user?: { id?: number }; labels?: { name?: string }[]
  head: { sha: string; ref: string; repo?: { full_name?: string } | null }; base: { repo?: { full_name?: string } }
}
type Closed = { action?: string; repository?: { full_name?: string }; pull_request?: { number?: number } }
export type FixStart = ReturnType<typeof fixTask> & { live: boolean; began: () => void }

const stuckPull = (p: RawPull): StuckPull => ({
  number: p.number, title: p.title ?? '', url: p.html_url ?? '', open: p.state === 'open', draft: p.draft === true,
  fromFork: p.head.repo?.full_name !== p.base.repo?.full_name, authorId: p.user?.id, sha: p.head.sha, branch: p.head.ref,
  labels: (p.labels ?? []).map(l => l.name ?? ''),
})

export function fixer(o: Options) {
  const live = o.mode === 'on', seen: Seen = live ? o.seen.load() : {}
  const keep = () => { if (live) o.seen.save(seen) }
  const forget = (raw: unknown) => {
    const p = (raw ?? {}) as Closed, at = `${p.repository?.full_name}#${p.pull_request?.number}`
    if (p.action === 'closed' && seen[at]) { delete seen[at]; keep() }
  }
  return {
    async handle(type: string, raw: unknown): Promise<FixStart[]> {
      if (type === 'pull_request') forget(raw)
      const e = stuckEvent(type, raw, o.slug)
      if (!e) return []
      if (!o.allowed(e.installation)) { log(`github fix dropped ${e.repo}: installation ${e.installation} is not allowed`); return [] }
      const call = o.call(e.installation), starts: FixStart[] = []
      const prs = e.prs.length ? e.prs : (await call('GET', `/repos/${e.repo}/commits/${e.sha}/pulls`) as { number: number }[]).map(p => p.number)
      for (const n of prs) {
        const at = `${e.repo}#${n}`, pull = stuckPull(await call('GET', `/repos/${e.repo}/pulls/${n}`) as RawPull), was = seen[at]
        const v = fixVerdict(e, pull, o, was)
        if (!v.start) {
          log(`github fix skipped ${at}: ${v.why}`)
          if (v.spent && was && !was.told) { was.told = true; keep(); o.notify(ownerLines.githubFixSpent(at, was.tries, pull.url)) }
          continue
        }
        const began = () => {
          const now = seen[at]
          seen[at] = { keys: [...(now?.keys ?? []), v.key], tries: (now?.tries ?? 0) + 1 }
          keep()
          log(`github fix ${live ? 'starts' : 'would start (shadow)'} ${at}@${e.sha.slice(0, 7)}: ${e.reason}`)
        }
        if (!live) began()
        starts.push({ ...fixTask(e, pull), live, began })
      }
      return starts
    },
  }
}
