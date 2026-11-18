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
  usage?: () => Promise<Parameters<typeof planDetail>[0]> | undefined
  shape?: () => Record<string, number>
}

export function installId(dir: string): string {
  const f = `${dir}/telemetry-id`
  if (existsSync(f)) return readFileSync(f, 'utf8').trim()
  const id = randomUUID()
  writeFileSync(f, `${id}\n`, { mode: 0o600 })
  return id
}

function lastRunWhy(file: string) {
  try { return bootWhy(readFileSync(file, 'utf8').split('\n').slice(-2000).join('\n')) } catch { return 'first' }
}

export function startTelemetry(o: Deps) {
  const endpoint = telemetryEndpoint(o.config, process.env)
  process.prependListener('uncaughtException', e => { try { o.ledgers.event({ kind: 'crash', who: 'hub', trace: '', detail: crashFingerprint(e, o.code) }) } catch {  } })
  const event = (kind: 'boot' | 'error' | 'shape', detail: string) => o.ledgers.event({ kind, who: 'hub', trace: '', detail })
  event('boot', lastRunWhy(`${o.dir}/hub.log`))
  const lastError = new Map<string, number>()
  tapLog(first => { const c = errorCode(first), now = Date.now(); if (c && now - (lastError.get(c) ?? 0) > 60_000) { lastError.set(c, now); event('error', c) } })
  const shape = () => {
    const day = new Date().toISOString().slice(0, 10)
    if (!o.shape || o.state.load('shape-day') === day) return
    o.state.save('shape-day', day)
    event('shape', Object.entries(o.shape()).map(([k, v]) => `${k}=${v}`).join(' '))
  }
  shape()
  if (!endpoint) { o.state.save('telemetry-cursor', undefined); return [] }
  const version = (JSON.parse(readFileSync(`${o.code}/package.json`, 'utf8')) as { version: string }).version
  const resource = { 'service.name': 'kage', 'service.version': version, 'kage.install': installId(o.dir), 'os.type': platform(), 'host.arch': arch() }
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
    const d = told() ? planDetail(await Promise.race([o.usage?.()?.catch(() => undefined), new Promise<undefined>(r => setTimeout(r, 30_000))]) ?? { subscription_type: null, rate_limits: null }) : undefined
    if (d) o.ledgers.event({ kind: 'plan', who: 'hub', trace: '', detail: d })
  } }, { name: 'shape', every: 3_600_000, run: shape }]
}
