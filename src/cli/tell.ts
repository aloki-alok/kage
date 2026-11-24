#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { connect } from 'node:net'
import { asOwner, DIR } from './home.ts'
import { pickThread } from './pick-thread.ts'
import { errVoice } from './voice.ts'

const SOCK = `${DIR}/router.sock`
if (process.env.KAGE_CLAUDE) { console.error('This shell runs inside Kage: a session cannot speak as the owner.'); process.exit(1) }
if (!existsSync(`${DIR}/kage.db`) || !existsSync(SOCK)) { console.error(errVoice.says("I'm not running. Start me with kage start.")); process.exit(1) }
const [arg = '', ...words] = process.argv.slice(2)
const text = words.join(' ').trim()
if (!arg || !text) { console.error('Usage: kage thread send <place> <message>'); process.exit(1) }

const { key, place } = await pickThread(arg)

const s = connect(SOCK)
let buf = ''
s.on('connect', () => s.write(JSON.stringify(asOwner({ type: 'tell', key, text })) + '\n'))
s.on('data', b => {
  buf += b
  const i = buf.indexOf('\n')
  if (i < 0) return
  const r = JSON.parse(buf.slice(0, i)) as { ok?: true; held?: true; refused?: string }
  s.destroy()
  if (r.ok) console.error(r.held ? `Told ${place}. It is open in kage thread attach, so it reads this when you quit there.` : `Told ${place}.`)
  else { console.error(`Could not tell ${place}: ${r.refused}.`); process.exitCode = 1 }
})
s.on('error', e => { console.error(`Kage did not answer: ${e.message}`); process.exitCode = 1 })
