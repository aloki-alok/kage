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

// The soak gate (ADR 0008, 0013): a commit may become a release only after the owner's hub ran it for 24 hours.
// since (the first boot of the run on this commit, see soakSince) and crashDmAt are ms since the epoch.
const DAY = 86_400_000
export type Soak = { candidate: string; running: string; since?: number; crashDmAt?: number; doctorOk: boolean; now: number }
export function soakGate(s: Soak): { ok: true } | { fail: string } {
  const run = s.running.trim()
  if (!run || !s.candidate.startsWith(run)) return { fail: `the hub runs ${run || 'an unknown version'}, not ${s.candidate.slice(0, 7)}` }
  if (s.since === undefined) return { fail: 'the hub start time is unknown' }
  const up = s.now - s.since
  if (up < DAY) return { fail: `the hub has run it for ${Math.floor(up / 3_600_000)} hours, not 24` }
  if (s.crashDmAt !== undefined && s.now - s.crashDmAt < DAY) return { fail: `a crash-loop DM went out ${Math.floor((s.now - s.crashDmAt) / 3_600_000)} hours ago` }
  if (!s.doctorOk) return { fail: 'kage doctor is not "All good"' }
  return { ok: true }
}

// The boots ledger ("<iso time>\t<sha>" per hub start, oldest first): when the unbroken run of boots on `sha` began.
// A restart on the same commit keeps the clock. A boot on another commit ends the run, so only new code resets it.
export function soakSince(boots: string, sha: string): number | undefined {
  let since: number | undefined
  for (const line of boots.split('\n').filter(Boolean).reverse()) {
    const [at = '', s = ''] = line.split('\t')
    if (!s || !(s.startsWith(sha) || sha.startsWith(s))) break
    const t = Date.parse(at)
    if (Number.isNaN(t)) break   // a row with no readable time ends the run: the gate then waits
    since = t
  }
  return since
}
