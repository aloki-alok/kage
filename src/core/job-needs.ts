import { runTrust, type RunTrust, type Schedule } from './cron.ts'
import { OWN_TOOLS, ownerOnlyTool } from './guards.ts'

type ServerStatus = { name: string; status: string; tools?: { name: string }[] }
type NeedsJob = { id: string; place: string; needs: string[]; missing?: string[]; runs?: RunTrust }
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
const teammateHas = (t: string) => own(t) && !ownerOnlyTool(t)

export function needsChanges(jobs: NeedsJob[], live: Live): { id: string; missing: string[]; dm?: string }[] {
  return jobs.flatMap(j => {
    const owner = (j.runs ?? 'owner') === 'owner', ignored = owner ? own : teammateHas
    const stored = j.missing ?? [], was = stored.filter(t => !ignored(t)), unknown = (t: string) => owner && live.pending.some(p => t.startsWith(p))
    const missing = j.needs.filter(t => !ignored(t) && (unknown(t) ? was.includes(t) : !owner || !live.tools.has(t)))
    if (missing.length === stored.length && missing.every(t => stored.includes(t))) return []
    const dm = missing.some(t => !was.includes(t))
      ? owner
        ? `Job ${j.id} in ${j.place} needs ${missing.join(', ')}, and Kage's sessions do not have it now, so its runs cannot do that step. The connector likely needs you to sign in again (claude.ai, Settings, Connectors).`
        : j.runs === 'wake'
          ? `Job ${j.id} in ${j.place} needs ${missing.join(', ')}, but an event, watch or probe wake always runs with a teammate's trust, which loads none of your MCP tools, so its runs cannot do that step. To give it your tools, make it a clock job from your own DM with Kage.`
          : `Job ${j.id} in ${j.place} needs ${missing.join(', ')}, but its runs get a teammate's trust (a teammate asked for it, or wrote in its thread), which loads none of your MCP tools, so they cannot do that step. To give it your tools, set the job up again from your own DM with Kage.`
      : !missing.length && was.length ? `Job ${j.id} in ${j.place} has ${was.join(', ')} again.` : undefined
    const skipped = dm && !owner && toolless(j.needs, missing).length ? ' It has none of the tools it needs, so it runs no turn.' : ''
    return [{ id: j.id, missing, ...dm && { dm: dm + skipped } }]
  })
}

export function toolless(needs: string[] | undefined, missing: string[] | undefined): string[] {
  const outside = (needs ?? []).filter(t => !teammateHas(t))
  return outside.length && outside.every(t => missing?.includes(t)) ? outside : []
}

export function twinLacks(old: Schedule, twin: Schedule, o: { ownerThread: boolean; probesOn: boolean }): string[] {
  if (runTrust(old, o) !== 'owner' || runTrust(twin, o) === 'owner') return []
  return (old.needs ?? []).filter(t => !teammateHas(t))
}
