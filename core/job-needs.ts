type ServerStatus = { name: string; status: string; tools?: { name: string }[] }
type NeedsJob = { id: string; place: string; needs: string[]; missing?: string[] }

export function liveTools(servers: ServerStatus[]): Set<string> | undefined {
  if (servers.some(s => s.status === 'pending')) return undefined
  return new Set(servers.filter(s => s.status === 'connected').flatMap(s => (s.tools ?? []).map(t => `mcp__${s.name.replace(/[^a-zA-Z0-9_-]/g, '_')}__${t.name}`)))
}

export function needsChanges(jobs: NeedsJob[], tools: Set<string>): { id: string; missing: string[]; dm?: string }[] {
  return jobs.flatMap(j => {
    const was = j.missing ?? [], missing = j.needs.filter(t => !tools.has(t))
    if (missing.length === was.length && missing.every(t => was.includes(t))) return []
    const dm = missing.some(t => !was.includes(t))
      ? `Job ${j.id} in ${j.place} needs ${missing.join(', ')}, and Kage's sessions do not have it now, so its runs cannot do that step. The connector likely needs you to sign in again (claude.ai, Settings, Connectors).`
      : !missing.length ? `Job ${j.id} in ${j.place} has ${was.join(', ')} again.` : undefined
    return [{ id: j.id, missing, ...dm && { dm } }]
  })
}
