#!/usr/bin/env node
// kage call: Kage phones the owner. The hub issues a one-time code, and KAGE_CALL_COMMAND (your dialer,
// outside this repo) places the call with that code in $KAGE_CALL_CODE. The call that brings the code
// back is the owner (connectors/voice.ts). The code is never printed.
import { spawnSync } from 'node:child_process'
import { connect } from 'node:net'
import { dirname } from 'node:path'
import { load } from '../config.ts'

const { env, ENV_FILE } = load()
const command = env.KAGE_CALL_COMMAND
if (!command) {
  console.error(`Add KAGE_CALL_COMMAND=<command that places the call> to ${ENV_FILE}. It gets the code in $KAGE_CALL_CODE.`)
  process.exit(1)
}
const sock = connect(`${dirname(ENV_FILE)}/router.sock`)
sock.on('error', () => { console.error('Kage is not running. Start it with ./start.sh'); process.exit(1) })
sock.write(JSON.stringify({ type: 'callcode' }) + '\n')
let buf = ''
sock.on('data', chunk => {
  buf += chunk
  const i = buf.indexOf('\n')
  if (i < 0) return
  sock.destroy()
  const r = JSON.parse(buf.slice(0, i)) as { code?: string; refused?: string }
  if (!r.code) { console.error(`No call: ${r.refused ?? 'the hub gave no code'}. Set KAGE_VOICE_TOKEN and restart.`); process.exit(1) }
  const run = spawnSync(command, { shell: true, stdio: 'inherit', env: { ...process.env, KAGE_CALL_CODE: r.code } })
  process.exit(run.status ?? 1)
})
