#!/usr/bin/env node
// What this Kage sends, and where (ADR 0019).
//   kage telemetry         on or off, why, the endpoint and the install id
//   kage telemetry show    the exact body the next minute's batch would send, from the rows waiting now
// Turn it off with kage set telemetry.on false, KAGE_TELEMETRY=off or DO_NOT_TRACK=1.
import { existsSync, readFileSync } from 'node:fs'
import { arch, platform } from 'node:os'
import { DIR, ENV_FILE } from './home.ts'
import { otlpLogs, telemetryEndpoint, toTelemetry } from '../core/telemetry.ts'
import { readSettings } from '../runtime/config-files.ts'
import { openLedgers } from '../runtime/ledger.ts'
import { openStore } from '../runtime/store.ts'

const t = readSettings(ENV_FILE).config.telemetry
const endpoint = telemetryEndpoint(t, process.env)
const idFile = `${DIR}/telemetry-id`
const id = existsSync(idFile) ? readFileSync(idFile, 'utf8').trim() : '(made at the first send)'
if (process.argv[2] === 'show') {
  const l = openLedgers(DIR)
  const cursor = openStore(`${DIR}/kage.db`).load('telemetry-cursor') as number | undefined
  const rows = cursor === undefined ? [] : l.eventsAfter(cursor, 500)
  const version = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version
  console.log(JSON.stringify(JSON.parse(otlpLogs(rows.map(toTelemetry), { 'service.name': 'kage', 'service.version': version, 'kage.install': id, 'os.type': platform(), 'host.arch': arch() })), null, 2))
  console.error(`${rows.length} records wait${endpoint ? '' : ', and none will leave: telemetry is off'}`)
} else {
  const why = !t?.endpoint ? 'no telemetry.endpoint set' : t.on === false ? 'telemetry.on is false' : process.env.KAGE_TELEMETRY === 'off' ? 'KAGE_TELEMETRY=off' : 'DO_NOT_TRACK is set'
  console.log(endpoint ? `on: counts and failure codes go to ${endpoint}, install ${id}` : `off: ${why}`)
  console.log('Never sent: message text, prompts, replies, tool input. Claude Code adds the signed-in account (email and ids) to its own records. kage telemetry show prints Kage\'s next batch.')
}
