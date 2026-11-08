#!/usr/bin/env node
// kage voice-code: the hub DMs the owner a 6-digit code to say on a call (a web avatar, any agent with no
// dialer to carry the long `kage call` code). The call that says it is the owner (connectors/voice.ts).
// The code goes only to the owner's DM: this command, and any session that runs it, never sees it.
import { connect } from 'node:net'
import { DIR } from './home.ts'

const sock = connect(`${DIR}/router.sock`)
sock.on('error', () => { console.error('Kage is not running. Start it with kage start'); process.exit(1) })
sock.write(JSON.stringify({ type: 'voicecode' }) + '\n')
let buf = ''
sock.on('data', chunk => {
  buf += chunk
  const i = buf.indexOf('\n')
  if (i < 0) return
  sock.destroy()
  const r = JSON.parse(buf.slice(0, i)) as { ok?: true; refused?: string }
  if (!r.ok) { console.error(`No code: ${r.refused ?? 'the hub gave no answer'}.`); process.exit(1) }
  console.error('Sent your voice code to your DM with Kage. It works once, for 10 minutes.')
})
