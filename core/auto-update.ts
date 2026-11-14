// Auto-update: whether the hub may pull origin/main into its own checkout. It moves only a clean main
// that origin is strictly ahead of, by fast-forward. Every other checkout is someone's working copy.

// What the hub knows about its checkout. ahead and behind are counts against origin/main, known once fetched.
export type Checkout = { git: boolean; branch?: string; dirty?: boolean; fetchError?: string; ahead?: number; behind?: number }
export type Step = 'fetch' | 'pull' | 'current' | { skip: string }

export function nextStep(c: Checkout): Step {
  if (!c.git) return { skip: 'not a git checkout' }
  if (c.branch !== 'main') return { skip: `on branch ${c.branch}, not main` }
  if (c.dirty) return { skip: 'the checkout has uncommitted changes' }
  if (c.fetchError !== undefined) return { skip: `git fetch failed: ${c.fetchError}` }
  if (c.ahead === undefined || c.behind === undefined) return 'fetch'
  if (c.ahead > 0) return { skip: `main has ${c.ahead} local commit${c.ahead === 1 ? '' : 's'} that origin/main lacks` }
  return c.behind > 0 ? 'pull' : 'current'
}

// The GitHub page that lists the commits between two versions, from the checkout's origin url.
export function compareUrl(origin: string, from: string, to: string): string | undefined {
  const m = /github\.com[/:]([^/]+)\/(.+?)(\.git)?$/.exec(origin.trim())
  return m ? `https://github.com/${m[1]}/${m[2]}/compare/${from}...${to}` : undefined
}
