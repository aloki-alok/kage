// Telemetry in the hub (ADR 0019): the anonymous install id, the minute export of gated event rows, Claude Code's own
// telemetry for every session (set on the hub's env, which each session copies), and the crash code written before exit.
// Returns the hub's timed job, or none when telemetry is off.
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { arch, platform } from 'node:os'
import type { Config } from '../core/config.ts'
import { crashFingerprint, sessionTelemetryEnv, telemetryEndpoint } from '../core/telemetry.ts'
import { log } from '../runtime/log.ts'
import { telemetryExporter, type ExportDeps } from '../runtime/telemetry-export.ts'

type Deps = {
  config: Config['telemetry']; dir: string; code: string
  ledgers: { eventsAfter: ExportDeps['events']; maxEventId: () => number; event: (e: { kind: 'crash'; who: string; trace: string; detail: string }) => void }
  state: { load: (name: string) => unknown; save: (name: string, v: unknown) => void }
}

// A random id made once per install: it links one machine's records to each other and to nothing else.
export function installId(dir: string): string {
  const f = `${dir}/telemetry-id`
  if (existsSync(f)) return readFileSync(f, 'utf8').trim()
  const id = randomUUID()
  writeFileSync(f, `${id}\n`, { mode: 0o600 })
  return id
}

export function startTelemetry(o: Deps) {
  const endpoint = telemetryEndpoint(o.config, process.env)
  // Before the router's own handler, which exits. The row is local; the next start sends it.
  // ponytail: a crash before the job list is built is not counted, move this up if startup crashes matter.
  process.prependListener('uncaughtException', e => { try { o.ledgers.event({ kind: 'crash', who: 'hub', trace: '', detail: crashFingerprint(e, o.code) }) } catch { /* dying anyway */ } })
  if (!endpoint) return []
  const version = (JSON.parse(readFileSync(`${o.code}/package.json`, 'utf8')) as { version: string }).version
  const resource = { 'service.name': 'kage', 'service.version': version, 'kage.install': installId(o.dir), 'os.type': platform(), 'host.arch': arch() }
  Object.assign(process.env, sessionTelemetryEnv(endpoint, resource))
  const exporter = telemetryExporter({
    events: o.ledgers.eventsAfter, maxId: o.ledgers.maxEventId, resource,
    cursor: { load: () => o.state.load('telemetry-cursor') as number | undefined, save: id => o.state.save('telemetry-cursor', id) },
    post: async body => (await fetch(`${endpoint}/v1/logs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(10_000) })).status,
  })
  log(`telemetry on: ${endpoint}, install ${resource['kage.install']}`)
  return [{ name: 'telemetry', every: 60_000, run: () => exporter.run() }]
}
