// Telemetry in the hub (ADR 0019): the anonymous install id, the minute export of gated event rows, Claude Code's own
// telemetry for every session (set on the hub's env, which each session copies), and the crash code written before exit.
// Returns the hub's timed job, or none when telemetry is off.
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { arch, platform } from 'node:os'
import type { Config } from '../core/config.ts'
import { bootWhy, crashFingerprint, errorCode, planDetail, sessionTelemetryEnv, TELEMETRY_NOTICE, telemetryEndpoint } from '../core/telemetry.ts'
import { log, tapLog } from '../runtime/log.ts'
import { telemetryExporter, type ExportDeps } from '../runtime/telemetry-export.ts'

type Deps = {
  config: Config['telemetry']; dir: string; code: string
  ledgers: { eventsAfter: ExportDeps['events']; maxEventId: () => number; event: (e: { kind: 'crash' | 'plan' | 'boot' | 'error' | 'shape'; who: string; trace: string; detail: string }) => void }
  state: { load: (name: string) => unknown; save: (name: string, v: unknown) => void }
  notify: (text: string) => Promise<boolean>
  // How full the seat's usage windows are, read through a live session; undefined with none running.
  usage?: () => Promise<Parameters<typeof planDetail>[0]> | undefined
  shape?: () => Record<string, number>   // what this install has switched on (core/telemetry.ts SHAPE)
}

// A random id made once per install: it links one machine's records to each other and to nothing else.
export function installId(dir: string): string {
  const f = `${dir}/telemetry-id`
  if (existsSync(f)) return readFileSync(f, 'utf8').trim()
  const id = randomUUID()
  writeFileSync(f, `${id}\n`, { mode: 0o600 })
  return id
}

// How the run before this one ended (core/telemetry.ts bootWhy), from the end of the log.
function lastRunWhy(file: string) {
  try { return bootWhy(readFileSync(file, 'utf8').split('\n').slice(-2000).join('\n')) } catch { return 'first' }
}

export function startTelemetry(o: Deps) {
  const endpoint = telemetryEndpoint(o.config, process.env)
  // Before the router's own handler, which exits. The row is local; the next start sends it.
  // ponytail: a crash before the job list is built is not counted, move this up if startup crashes matter.
  process.prependListener('uncaughtException', e => { try { o.ledgers.event({ kind: 'crash', who: 'hub', trace: '', detail: crashFingerprint(e, o.code) }) } catch { /* dying anyway */ } })
  // Rows for the local event log too, telemetry on or off: how the last run ended (hub.ts reads it), and our error lines.
  const event = (kind: 'boot' | 'error' | 'shape', detail: string) => o.ledgers.event({ kind, who: 'hub', trace: '', detail })
  event('boot', lastRunWhy(`${o.dir}/hub.log`))
  // ponytail: one row per code a minute, so a flood counts as one; a count field if the rate matters.
  const lastError = new Map<string, number>()
  tapLog(first => { const c = errorCode(first), now = Date.now(); if (c && now - (lastError.get(c) ?? 0) > 60_000) { lastError.set(c, now); event('error', c) } })
  // Once a UTC day, tried at start and hourly: the job clock restarts with the hub, which may restart within the hour.
  const shape = () => {
    const day = new Date().toISOString().slice(0, 10)
    if (!o.shape || o.state.load('shape-day') === day) return
    o.state.save('shape-day', day)
    event('shape', Object.entries(o.shape()).map(([k, v]) => `${k}=${v}`).join(' '))
  }
  shape()
  // Off: forget the cursor, so turning it on again sends only what happens after, not the off months.
  if (!endpoint) { o.state.save('telemetry-cursor', undefined); return [] }
  const version = (JSON.parse(readFileSync(`${o.code}/package.json`, 'utf8')) as { version: string }).version
  const resource = { 'service.name': 'kage', 'service.version': version, 'kage.install': installId(o.dir), 'os.type': platform(), 'host.arch': arch() }
  // Nothing leaves before the owner's one DM about it is out; the exporter then starts after the newest row.
  const told = () => o.state.load('telemetry-told') === true
  const sessionsOn = () => Object.assign(process.env, sessionTelemetryEnv(endpoint, resource))
  if (told()) sessionsOn()
  const exporter = telemetryExporter({
    events: o.ledgers.eventsAfter, maxId: o.ledgers.maxEventId, resource,
    cursor: { load: () => o.state.load('telemetry-cursor') as number | undefined, save: id => o.state.save('telemetry-cursor', id) },
    post: async body => (await fetch(`${endpoint}/v1/logs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(10_000) })).status,
  })
  log(`telemetry on: ${endpoint}, install ${resource['kage.install']}`)
  return [{ name: 'telemetry', every: 60_000, run: async () => {
    if (!told()) {
      if (!await o.notify(TELEMETRY_NOTICE)) return
      o.state.save('telemetry-told', true)
      sessionsOn()
    }
    await exporter.run()
  } }, { name: 'plan usage', every: 15 * 60_000, run: async () => {
    // ponytail: rides the SDK's experimental usage call, so a release that renames it only stops these rows.
    const d = told() ? planDetail(await Promise.race([o.usage?.()?.catch(() => undefined), new Promise<undefined>(r => setTimeout(r, 30_000))]) ?? { subscription_type: null, rate_limits: null }) : undefined
    if (d) o.ledgers.event({ kind: 'plan', who: 'hub', trace: '', detail: d })
  } }, { name: 'shape', every: 3_600_000, run: shape }]
}
