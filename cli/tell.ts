#!/usr/bin/env node
// kage tell <place> <message>: tell one thread's session something, as the owner, from this terminal.
// The session gets it as its next task (after the current turn) and answers in the thread as usual.
//   kage tell support use the staging db       the one thread whose place contains "support"
//   kage tell "pr review" hold the merge        quote a place with spaces
import { existsSync } from 'node:fs'
import { connect } from 'node:net'
import { DIR } from './home.ts'
import { pickThread } from './pick-thread.ts'

const SOCK = `${DIR}/router.sock`
if (process.env.KAGE_CLAUDE) { console.error('This shell runs inside Kage: a session cannot speak as the owner.'); process.exit(1) }
if (!existsSync(`${DIR}/kage.db`) || !existsSync(SOCK)) { console.error('Kage is not running: start it with kage start'); process.exit(1) }
const [arg = '', ...words] = process.argv.slice(2)
const text = words.join(' ').trim()
if (!arg || !text) { console.error('Usage: kage tell <place> <message>'); process.exit(1) }

const { key, place } = await pickThread(arg)

const s = connect(SOCK)
let buf = ''
s.on('connect', () => s.write(JSON.stringify({ type: 'tell', key, text }) + '\n'))
s.on('data', b => {
  buf += b
  const i = buf.indexOf('\n')
  if (i < 0) return
  const r = JSON.parse(buf.slice(0, i)) as { ok?: true; held?: true; refused?: string }
  s.destroy()
  if (r.ok) console.error(r.held ? `Told ${place}. It is open in kage attach, so it reads this when you quit there.` : `Told ${place}.`)
  else { console.error(`Could not tell ${place}: ${r.refused}.`); process.exitCode = 1 }
})
s.on('error', e => { console.error(`Kage did not answer: ${e.message}`); process.exitCode = 1 })
