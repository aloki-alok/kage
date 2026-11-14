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
  if (c.fetchError !== undefined) return { skip: `git fetch failed: ${c.fetchError}` }
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
