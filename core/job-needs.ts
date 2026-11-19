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

export function needsChanges(jobs: NeedsJob[], live: Live): { id: string; missing: string[]; dm?: string }[] {
  return jobs.flatMap(j => {
    const was = j.missing ?? [], unknown = (t: string) => live.pending.some(p => t.startsWith(p))
    const missing = j.needs.filter(t => unknown(t) ? was.includes(t) : !live.tools.has(t))
    if (missing.length === was.length && missing.every(t => was.includes(t))) return []
    const dm = missing.some(t => !was.includes(t))
      ? `Job ${j.id} in ${j.place} needs ${missing.join(', ')}, and Kage's sessions do not have it now, so its runs cannot do that step. The connector likely needs you to sign in again (claude.ai, Settings, Connectors).`
      : !missing.length ? `Job ${j.id} in ${j.place} has ${was.join(', ')} again.` : undefined
    return [{ id: j.id, missing, ...dm && { dm } }]
  })
}
