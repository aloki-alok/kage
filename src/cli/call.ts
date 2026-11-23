#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { askHub, settings } from './home.ts'
import { errVoice } from './voice.ts'

const { config } = settings()
const command = config.connectors?.call?.command
if (!command) {
  console.error(`Run kage set connectors.call.command '<command that places the call>'. It gets the code in $KAGE_CALL_CODE.`)
  process.exit(1)
}
const r = await askHub<{ code?: string; refused?: string }>({ type: 'callcode' })
  .catch(() => { console.error(errVoice.says("I'm not running. Start me with kage start.")); process.exit(1) })
if (!r.code) { console.error(`No call: ${r.refused ?? 'the hub gave no code'}. Set voiceToken in secrets.json and restart.`); process.exit(1) }
const run = spawnSync(command, { shell: true, stdio: 'inherit', env: { ...process.env, KAGE_CALL_CODE: r.code } })
process.exit(run.status ?? 1)
