import { OWN_TOOLS } from './guards.ts'

type ServerStatus = { name: string; status: string; tools?: { name: string }[] }
type NeedsJob = { id: string; place: string; needs: string[]; missing?: string[] }
type Live = { tools: Set<string>; pending: string[] }

const mcpName = (s: string) => {
  const r = s.replace(/[^a-zA-Z0-9_-]/g, '_')
  return s.startsWith('claude.ai ') ? r.replace(/_+/g, '_').replace(/^_|_$/g, '') : r
}

export function liveTools(servers: ServerStatus[]): Live {
  return {
    tools: new Set(servers.filter(s => s.status === 'connected').flatMap(s => (s.tools ?? []).map(t => `mcp__${mcpName(s.name)}__${mcpName(t.name)}`))),
    pending: servers.filter(s => s.status === 'pending').map(s => `mcp__${mcpName(s.name)}__`),
  }
}

const own = (t: string) => OWN_TOOLS.test(t)

export function needsChanges(jobs: NeedsJob[], live: Live): { id: string; missing: string[]; dm?: string }[] {
  return jobs.flatMap(j => {
    const stored = j.missing ?? [], was = stored.filter(t => !own(t)), unknown = (t: string) => live.pending.some(p => t.startsWith(p))
    const missing = j.needs.filter(t => !own(t) && (unknown(t) ? was.includes(t) : !live.tools.has(t)))
    if (missing.length === stored.length && missing.every(t => stored.includes(t))) return []
    const dm = missing.some(t => !was.includes(t))
      ? `Job ${j.id} in ${j.place} needs ${missing.join(', ')}, and Kage's sessions do not have it now, so its runs cannot do that step. The connector likely needs you to sign in again (claude.ai, Settings, Connectors).`
      : !missing.length && was.length ? `Job ${j.id} in ${j.place} has ${was.join(', ')} again.` : undefined
    return [{ id: j.id, missing, ...dm && { dm } }]
  })
}
