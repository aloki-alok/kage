
export type Entry =
  | { kind: 'person'; id: string; trusted?: true }
  | { kind: 'agent'; id: string; owner?: string; tag?: string }

export const validUserId = (id: string) => /^[UW][A-Z0-9]{2,}$/.test(id)
export const pastedId = (word: string) => /^<@([UW][A-Z0-9]{2,})(\|[^>]*)?>$/.exec(word.trim())?.[1] ?? word
export const validAppId = (id: string) => /^A[A-Z0-9]{2,}$/.test(id)
export const kindOf = (id: string): Entry['kind'] | undefined => (validUserId(id) ? 'person' : validAppId(id) ? 'agent' : undefined)

export function appEntry(s: string): { id: string; owner?: string; tag?: string } | undefined {
  const [id = '', owner, tag, more] = s.split(':')
  if (!validAppId(id) || more !== undefined) return undefined
  if (owner === undefined) return { id }
  if (!kindOf(owner) || owner === id) return undefined
  if (tag === undefined) return { id, owner }
  return validUserId(tag) ? { id, owner, tag } : undefined
}

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

export function add(entries: Entry[], e: Entry): { entries: Entry[]; added: Entry[] } | { error: string } {
  if (e.kind === 'person') return entries.some(x => x.id === e.id) ? { entries, added: [] } : { entries: [...entries, e], added: [e] }
  const owner = e.owner
  if (!owner) return { error: `agent ${e.id} needs an owner: the person or the agent it answers to` }
  if (owner === e.id) return { error: `agent ${e.id} cannot be its own owner` }
  const had = entries.find(x => x.id === e.id)
  const tag = e.tag ?? (had?.kind === 'agent' ? had.tag : undefined)
  const agent: Entry = { kind: 'agent', id: e.id, owner, ...(tag && { tag }) }
  if (had?.kind === 'agent' && had.owner === owner && had.tag === tag) return { entries, added: [] }
  const ownerIsPerson = kindOf(owner) === 'person'
  const newOwner: Entry[] = ownerIsPerson && !entries.some(x => x.id === owner) ? [{ kind: 'person', id: owner }] : []
  if (!ownerIsPerson && !entries.some(x => x.id === owner)) return { error: `the owner ${owner} is not listed. Add it first.` }
  if (!ownerIsPerson && owner !== had?.id && !ownerPerson(entries, owner)) return { error: `the owner ${owner} has no owner itself. Tie it to its owner first: kage add ${owner} <its owner>` }
  const people = [...entries.filter(x => x.kind === 'person'), ...newOwner]
  const agents = had ? entries.filter(x => x.kind === 'agent').map(x => (x.id === e.id ? agent : x)) : [...entries.filter(x => x.kind === 'agent'), agent]
  const next = [...people, ...agents]
  if (!ownerPerson(next, e.id)) return { error: `that would make a loop: ${owner} answers to ${e.id}` }
  return { entries: next, added: [...newOwner, agent] }
}

export function remove(entries: Entry[], id: string): { entries: Entry[]; removed: Entry[] } {
  const gone = new Set(entries.some(e => e.id === id) ? [id] : [])
  for (let grew = true; grew;) {
    grew = false
    for (const e of entries) if (e.kind === 'agent' && e.owner && gone.has(e.owner) && !gone.has(e.id)) { gone.add(e.id); grew = true }
  }
  return { entries: entries.filter(e => !gone.has(e.id)), removed: entries.filter(e => gone.has(e.id)) }
}
