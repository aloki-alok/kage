#!/usr/bin/env node
// kage call: Kage phones the owner. The hub issues a one-time code, and connectors.call.command (your dialer,
// outside this repo) places the call with that code in $KAGE_CALL_CODE. The call that brings the code
// back is the owner (connectors/voice.ts). The code is never printed.
import { spawnSync } from 'node:child_process'
import { askHub, settings } from './home.ts'

const { config } = settings()
const command = config.connectors?.call?.command
if (!command) {
  console.error(`Run kage set connectors.call.command '<command that places the call>'. It gets the code in $KAGE_CALL_CODE.`)
  process.exit(1)
}
const r = await askHub<{ code?: string; refused?: string }>({ type: 'callcode' })
  .catch(() => { console.error('Kage is not running. Start it with kage start'); process.exit(1) })
if (!r.code) { console.error(`No call: ${r.refused ?? 'the hub gave no code'}. Set voiceToken in secrets.json and restart.`); process.exit(1) }
const run = spawnSync(command, { shell: true, stdio: 'inherit', env: { ...process.env, KAGE_CALL_CODE: r.code } })
process.exit(run.status ?? 1)
