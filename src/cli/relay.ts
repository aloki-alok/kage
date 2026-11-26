#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { connect } from 'node:net'
import { asOwner, DIR, notRunning } from './home.ts'
import { pickChannel, pickThread } from './pick-thread.ts'
import { outputFlags, printJson } from './output.ts'

const SOCK = `${DIR}/router.sock`
if (process.env.KAGE_CLAUDE) { console.error('This shell runs inside Kage: a session cannot change the relay list.'); process.exit(1) }
if (!existsSync(`${DIR}/kage.db`) || !existsSync(SOCK)) notRunning()
const out = outputFlags(process.argv.slice(2))
const [action = '', arg = '', channelArg = ''] = out.args
const wholeChannel = action !== 'list' && arg === 'channel'
if (!['allow', 'deny', 'list'].includes(action) || (action !== 'list' && !arg) || (wholeChannel && !channelArg)) {
  console.error('Usage: kage relay allow <place or key> | allow channel <#name or channel id> | deny <same> | list')
  process.exit(2)
}

const key = action === 'list' ? undefined : wholeChannel ? pickChannel(channelArg) : (await pickThread(arg, false)).key

const s = connect(SOCK)
let buf = ''
s.on('connect', () => s.write(JSON.stringify(asOwner({ type: 'relay', action, key })) + '\n'))
s.on('data', b => {
  buf += b
  const i = buf.indexOf('\n')
  if (i < 0) return
  const r = JSON.parse(buf.slice(0, i)) as { ok?: true; keys?: string[]; refused?: string }
  s.destroy()
  if (!r.ok) { console.error(`Refused: ${r.refused}.`); process.exitCode = 1; return }
  if (action !== 'list') console.error(`${action === 'allow' ? 'Allowed' : 'Denied'} ${wholeChannel ? `every thread in ${key}` : key}.`)
  if (out.json) printJson(r.keys, out.jq)
  else console.log(r.keys!.length ? r.keys!.join('\n') : '(nothing is listed)')
})
s.on('error', e => { console.error(`Kage did not answer: ${e.message}`); process.exitCode = 1 })
