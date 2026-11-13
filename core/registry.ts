// The registry: who may reach Kage besides the owner. A person is a Slack user id. An agent is a Slack app id
// with one owner, who is a listed person or a listed agent (its manager). It lives in two lines of the env
// file: KAGE_TEAMMATES=<user>,... and KAGE_TRUSTED_APPS=<app>:<owner>,... `kage add`, `remove` and `list` (cli/registry.ts) are its only writers.

export type Entry =
  | { kind: 'person'; id: string }
  // No owner: listed by hand before owners existed. Any listed person's post through it counts (core/slack-message.ts).
  | { kind: 'agent'; id: string; owner?: string }

export const validUserId = (id: string) => /^[UW][A-Z0-9]{2,}$/.test(id)
// A Slack app id. It goes into the env file, so it is one plain word.
export const validAppId = (id: string) => /^A[A-Z0-9]{2,}$/.test(id)
export const kindOf = (id: string): Entry['kind'] | undefined => (validUserId(id) ? 'person' : validAppId(id) ? 'agent' : undefined)

// One entry of KAGE_TRUSTED_APPS: "<app>" or "<app>:<owner>". Anything else is no entry.
export function appEntry(s: string): { id: string; owner?: string } | undefined {
  const [id = '', owner, more] = s.split(':')
  if (!validAppId(id) || more !== undefined) return undefined
  if (owner === undefined) return { id }
  return kindOf(owner) && owner !== id ? { id, owner } : undefined
}

// A comma separated list in the env file. Read the way core/settings.ts reads the file: optional indent, spaces and quotes.
const listLine = (name: string) => new RegExp(`^\\s*${name}\\s*=\\s*["']?(.*?)["']?\\s*$`)
export const listIn = (env: string, name: string) =>
  (env.split('\n').map(l => listLine(name).exec(l)?.[1]).findLast(v => v !== undefined) ?? '')
    .split(',').map(s => s.trim()).filter(Boolean)

// The env file with that list set to these ids; every other line stays as it was.
export function withList(env: string, name: string, ids: string[]): string {
  const rest = env.replace(/\n+$/, '').split('\n').filter(l => !listLine(name).test(l))
  const unique = [...new Set(ids)]
  return [...rest, ...(unique.length ? [`${name}=${unique.join(',')}`] : [])].join('\n') + '\n'
}

export const registryIn = (env: string): Entry[] => [
  ...listIn(env, 'KAGE_TEAMMATES').map(id => ({ kind: 'person' as const, id })),
  ...listIn(env, 'KAGE_TRUSTED_APPS').flatMap(s => { const a = appEntry(s); return a ? [{ kind: 'agent' as const, ...a }] : [] }),
]

export const withRegistry = (env: string, entries: Entry[]): string =>
  withList(
    withList(env, 'KAGE_TEAMMATES', entries.filter(e => e.kind === 'person').map(e => e.id)),
    'KAGE_TRUSTED_APPS', entries.flatMap(e => (e.kind === 'agent' ? [e.owner ? `${e.id}:${e.owner}` : e.id] : [])),
  )

// The listed person at the top of an agent's owner chain. None for an agent with no owner, an owner who is
// not listed, or a loop.
export function ownerPerson(entries: Entry[], app: string): string | undefined {
  const seen = new Set<string>()
  for (let id: string | undefined = app; id && !seen.has(id);) {
    seen.add(id)
    const e = entries.find(x => x.id === id)
    if (!e) return undefined
    if (e.kind === 'person') return e.id
    id = e.owner
  }
  return undefined
}

// kage add. An agent comes with its owner. An owner who is a person is added with it; an owner who is an
// agent must be listed already. An agent listed again moves to the new owner.
export function add(entries: Entry[], e: Entry): { entries: Entry[]; added: Entry[] } | { error: string } {
  if (e.kind === 'person') return entries.some(x => x.id === e.id) ? { entries, added: [] } : { entries: [...entries, e], added: [e] }
  if (!e.owner) return { error: `agent ${e.id} needs an owner: the person or the agent it answers to` }
  if (e.owner === e.id) return { error: `agent ${e.id} cannot be its own owner` }
  const had = entries.find(x => x.id === e.id)
  if (had?.kind === 'agent' && had.owner === e.owner) return { entries, added: [] }
  const ownerIsPerson = kindOf(e.owner) === 'person'
  const newOwner: Entry[] = ownerIsPerson && !entries.some(x => x.id === e.owner) ? [{ kind: 'person', id: e.owner }] : []
  if (!ownerIsPerson && !entries.some(x => x.id === e.owner)) return { error: `the owner ${e.owner} is not listed. Add it first.` }
  if (!ownerIsPerson && e.owner !== had?.id && !ownerPerson(entries, e.owner)) return { error: `the owner ${e.owner} has no owner itself. Tie it to its owner first: kage add ${e.owner} <its owner>` }
  const people = [...entries.filter(x => x.kind === 'person'), ...newOwner]
  const agents = had ? entries.filter(x => x.kind === 'agent').map(x => (x.id === e.id ? e : x)) : [...entries.filter(x => x.kind === 'agent'), e]
  const next = [...people, ...agents]
  if (!ownerPerson(next, e.id)) return { error: `that would make a loop: ${e.owner} answers to ${e.id}` }
  return { entries: next, added: [...newOwner, e] }
}

// kage remove. Whoever answers to the removed one goes with it: a person's agents, and the agents those own.
export function remove(entries: Entry[], id: string): { entries: Entry[]; removed: Entry[] } {
  const gone = new Set(entries.some(e => e.id === id) ? [id] : [])
  for (let grew = true; grew;) {
    grew = false
    for (const e of entries) if (e.kind === 'agent' && e.owner && gone.has(e.owner) && !gone.has(e.id)) { gone.add(e.id); grew = true }
  }
  return { entries: entries.filter(e => !gone.has(e.id)), removed: entries.filter(e => gone.has(e.id)) }
}
