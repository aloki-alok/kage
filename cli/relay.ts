#!/usr/bin/env node
// kage relay allow|deny <place or key>, kage relay list: which threads may use the SSM relay beyond the owner-trusted ones.
//   kage relay allow prod-monitor     the one thread whose place contains "prod-monitor"
import { existsSync } from 'node:fs'
import { connect } from 'node:net'
import { DIR } from './home.ts'
import { pickThread } from './pick-thread.ts'

const SOCK = `${DIR}/router.sock`
if (process.env.KAGE_CLAUDE) { console.error('This shell runs inside Kage: a session cannot change the relay list.'); process.exit(1) }
if (!existsSync(`${DIR}/kage.db`) || !existsSync(SOCK)) { console.error('Kage is not running: start it with kage start'); process.exit(1) }
const [action = '', arg = ''] = process.argv.slice(2)
if (!['allow', 'deny', 'list'].includes(action) || (action !== 'list' && !arg)) { console.error('Usage: kage relay allow <place or key> | deny <place or key> | list'); process.exit(1) }

const key = action === 'list' ? undefined : (await pickThread(arg, false)).key

const s = connect(SOCK)
let buf = ''
s.on('connect', () => s.write(JSON.stringify({ type: 'relay', action, key }) + '\n'))
s.on('data', b => {
  buf += b
  const i = buf.indexOf('\n')
  if (i < 0) return
  const r = JSON.parse(buf.slice(0, i)) as { ok?: true; keys?: string[]; refused?: string }
  s.destroy()
  if (!r.ok) { console.error(`Refused: ${r.refused}.`); process.exitCode = 1; return }
  if (action !== 'list') console.error(`${action === 'allow' ? 'Allowed' : 'Denied'} ${key}.`)
  console.log(r.keys!.length ? r.keys!.join('\n') : '(no thread is listed)')
})
s.on('error', e => { console.error(`Kage did not answer: ${e.message}`); process.exitCode = 1 })
