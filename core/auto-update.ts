// Auto-update: whether the hub may move its own checkout to origin's `stable` tag. Only the owner moves that tag,
// so a merge to main reaches no install until the owner says it is ready (main is unsigned, #58). It moves only a
// clean main that the tag is strictly ahead of, by fast-forward. Every other checkout is someone's working copy.

// What the hub knows about its checkout. stable: whether origin has the tag, known once asked. ahead and behind
// are counts against the tag, known once fetched.
export type Checkout = { git: boolean; branch?: string; dirty?: boolean; fetchError?: string; stable?: boolean; ahead?: number; behind?: number }
export type Step = 'fetch' | 'pull' | 'current' | { skip: string }

export function nextStep(c: Checkout): Step {
  if (!c.git) return { skip: 'not a git checkout' }
  if (c.branch !== 'main') return { skip: `on branch ${c.branch}, not main` }
  if (c.dirty) return { skip: 'the checkout has uncommitted changes' }
  if (c.fetchError !== undefined) return { skip: `could not reach origin: ${c.fetchError}` }
  if (c.stable === false) return { skip: 'origin has no stable tag yet' }
  if (c.ahead === undefined || c.behind === undefined) return 'fetch'
  if (c.ahead > 0) return { skip: `main has ${c.ahead} commit${c.ahead === 1 ? '' : 's'} that the stable tag lacks` }
  return c.behind > 0 ? 'pull' : 'current'
}

// The GitHub page that lists the commits between two versions, from the checkout's origin url.
export function compareUrl(origin: string, from: string, to: string): string | undefined {
  const m = /github\.com[/:]([^/]+)\/(.+?)(\.git)?$/.exec(origin.trim())
  return m ? `https://github.com/${m[1]}/${m[2]}/compare/${from}...${to}` : undefined
}

// The soak (ADR 0008, 0013): a commit becomes a release only after it ran 24 hours, unbroken, on the owner's hub.
// "Ran" is judged by a run: the boots from one commit until a boot on code that differs. Times are ms since the epoch.
const DAY = 86_400_000
const TEN_MIN = 600_000

// A boot's commit, and whether the diff from the previous commit touches only files the hub never runs.
export type Boot = { at: number; sha: string; inert: boolean }
export type Run = { sha: string; start: number; end?: number; crashed: boolean }

// One table: what the hub never runs. A match is a file whose change cannot alter the hub's behavior.
const INERT: RegExp[] = [/\.md$/i, /^docs\//, /(^|\/)tests\//, /^(\.claude\/)?skills\/.*\.(md|txt)$/, /^LICENSE/]
// Only the version may change in these.
const VERSION_FILES = /^(package\.json|package-lock\.json|\.claude-plugin\/[^/]+\.json)$/

// Every changed file must be inert. versionOnly says a version file differs in its version alone.
export const inertChange = (files: { path: string; versionOnly?: boolean }[]) =>
  files.every(f => VERSION_FILES.test(f.path) ? f.versionOnly === true : INERT.some(r => r.test(f.path)))

const same = (a: string, b: string) => a.startsWith(b) || b.startsWith(a)

// Three boots inside ten minutes is the hub's own crash loop (hub.ts): the time of each boot that makes it so.
const loops = (boots: Boot[]) => boots.filter((b, i) => i >= 2 && b.at - boots[i - 2]!.at < TEN_MIN).map(b => b.at)

// Runs in time order. A boot on the same commit, or on one that differs only inertly, continues the run and
// moves its commit forward. A crash voids the run it hits and starts a clean one at that moment, on the same commit.
export function soakRuns(boots: Boot[], crashes: number[]): Run[] {
  const events = [...boots.map(b => ({ t: b.at, b })), ...[...crashes, ...loops(boots)].map(t => ({ t, b: undefined }))]
    .sort((x, y) => x.t - y.t || (x.b ? -1 : 1))
  const runs: Run[] = []
  for (const { t, b } of events) {
    const cur = runs.at(-1)
    if (!b) {
      if (!cur) continue
      Object.assign(cur, { crashed: true, end: t })
      runs.push({ sha: cur.sha, start: t, crashed: false })
    } else if (cur && (b.inert || same(cur.sha, b.sha))) cur.sha = b.sha
    else {
      if (cur) cur.end = b.at
      runs.push({ sha: b.sha, start: b.at, crashed: false })
    }
  }
  return runs
}

// The newest commit that completed a clean 24-hour run and is ahead of the stable tag (ahead says which). It may be
// older than what the hub runs now. With none, the fail line names the next candidate and when its gate opens.
// doctorOk is read last by the caller, since it is slow: pass true first to learn whether it is needed.
export type Gate = { ok: true; sha: string } | { fail: string; sha?: string; opensAt?: number }
export function soakGate(s: { boots: Boot[]; crashes: number[]; now: number; doctorOk: boolean; ahead: (sha: string) => boolean }): Gate {
  const runs = soakRuns(s.boots, s.crashes)
  if (!runs.length) return { fail: 'no hub start is recorded yet' }
  const done = runs.filter(r => !r.crashed && (r.end ?? s.now) - r.start >= DAY && s.ahead(r.sha)).at(-1)
  if (done) return s.doctorOk ? { ok: true, sha: done.sha } : { fail: 'kage doctor is not "All good"', sha: done.sha }
  const next = runs.at(-1)!
  if (!s.ahead(next.sha)) return { fail: 'nothing newer than the stable tag has run on this hub yet' }
  const opensAt = next.start + DAY
  return { fail: `the next release candidate is ${next.sha}, its gate opens ${new Date(opensAt).toISOString()}`, sha: next.sha, opensAt }
}
