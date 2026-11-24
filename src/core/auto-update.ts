
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

export function compareUrl(origin: string, from: string, to: string): string | undefined {
  const m = /github\.com[/:]([^/]+)\/(.+?)(\.git)?$/.exec(origin.trim())
  return m ? `https://github.com/${m[1]}/${m[2]}/compare/${from}...${to}` : undefined
}

const DAY = 86_400_000
const TEN_MIN = 600_000

export type Boot = { at: number; sha: string; inert: boolean }
export type Run = { sha: string; start: number; end?: number; crashed: boolean }

const INERT: RegExp[] = [/\.md$/i, /^docs\/(?!.*\.[cm]?[jt]s$)/, /(^|\/)tests\//, /^(\.claude\/)?skills\/.*\.(md|txt)$/, /^LICENSE[\w-]*(\.(md|txt))?$/]
const VERSION_FILES = /^(package\.json|package-lock\.json|\.claude-plugin\/[^/]+\.json)$/

export const inertChange = (files: { path: string; versionOnly?: boolean }[]) =>
  files.every(f => VERSION_FILES.test(f.path) ? f.versionOnly === true : INERT.some(r => r.test(f.path)))

const same = (a: string, b: string) => a.startsWith(b) || b.startsWith(a)

const loops = (boots: Boot[]) => boots.filter((b, i) => i >= 2 && b.at - boots[i - 2]!.at < TEN_MIN).map(b => b.at)

function soakRuns(boots: Boot[], crashes: number[]): Run[] {
  const events = [...boots.map(b => ({ t: b.at, b })), ...[...new Set([...crashes, ...loops(boots)])].map(t => ({ t, b: undefined }))]
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

type Gate = { ok: true; sha: string } | { fail: string; sha?: string; opensAt?: number; held?: true }
export type ErrorSeen = { at: number; code: string }
const WEEK = 7 * DAY

function newErrorKinds(errors: ErrorSeen[], run: { start: number; end: number }): string[] {
  const before = new Set(errors.filter(e => e.at >= run.start - WEEK && e.at < run.start).map(e => e.code))
  return [...new Set(errors.filter(e => e.at >= run.start && e.at <= run.end && !before.has(e.code)).map(e => e.code))]
}

export function soakGate(s: { boots: Boot[]; crashes: number[]; now: number; doctorOk: boolean; ahead: (sha: string) => boolean; errors: ErrorSeen[] }): Gate {
  const runs = soakRuns(s.boots, s.crashes)
  if (!runs.length) return { fail: 'no hub start is recorded yet' }
  const done = runs.filter(r => !r.crashed && (r.end ?? s.now) - r.start >= DAY && s.ahead(r.sha)).at(-1)
  if (done) {
    const fresh = newErrorKinds(s.errors, { start: done.start, end: done.start + DAY })
    if (fresh.length) return { fail: `an error kind is new since ${done.sha} started: ${fresh.join(', ')}`, sha: done.sha, held: true }
    return s.doctorOk ? { ok: true, sha: done.sha } : { fail: 'kage doctor is not "All good"', sha: done.sha, held: true }
  }
  const next = runs.at(-1)!
  if (!s.ahead(next.sha)) return { fail: 'nothing newer than the stable tag has run on this hub yet' }
  const opensAt = next.start + DAY
  return { fail: `the next release candidate is ${next.sha}, its gate opens ${new Date(opensAt).toISOString()}`, sha: next.sha, opensAt }
}
