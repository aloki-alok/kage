#!/usr/bin/env node
// kage tell <place> <message>: tell one thread's session something, as the owner, from this terminal.
// The session gets it as its next task (after the current turn) and answers in the thread as usual.
//   kage tell support use the staging db       the one thread whose place contains "support"
//   kage tell "pr review" hold the merge        quote a place with spaces
import { existsSync } from 'node:fs'
import { connect } from 'node:net'
import { DatabaseSync } from 'node:sqlite'
import { DIR } from './home.ts'

const SOCK = `${DIR}/router.sock`
if (!existsSync(`${DIR}/kage.db`) || !existsSync(SOCK)) { console.error('Kage is not running: start it with kage start'); process.exit(1) }
const [arg = '', ...words] = process.argv.slice(2)
const text = words.join(' ').trim()
if (!arg || !text) { console.error('Usage: kage tell <place> <message>'); process.exit(1) }

// Same lookup as kage attach (cli/attach.ts): newest first, by key or by part of the place.
const db = new DatabaseSync(`${DIR}/kage.db`, { readOnly: true })
const rows = db.prepare(`select s.key, coalesce(c.place, s.key) as place from sessions s
  left join conversations c using (key) order by c.last_seen desc nulls last`).all() as { key: string; place: string }[]
let found = rows.filter(r => r.key === arg || r.place.toLowerCase().includes(arg.toLowerCase()))
if (found.length !== 1) {
  const list = (found.length ? found : rows).slice(0, 20)
  console.error(`${found.length} threads match "${arg}". Pick one (newest first):`)
  list.forEach((r, i) => console.error(`  ${String(i + 1).padStart(2)}. ${r.place}   (${r.key})`))
  if (!process.stdin.isTTY) process.exit(1)
  process.stderr.write('Number: ')
  const n = Number(await new Promise<string>(r => process.stdin.once('data', b => r(String(b).trim()))))
  process.stdin.pause()
  if (!list[n - 1]) { console.error('No such number.'); process.exit(1) }
  found = [list[n - 1]!]
}
const { key, place } = found[0]!

const s = connect(SOCK)
let buf = ''
s.on('connect', () => s.write(JSON.stringify({ type: 'tell', key, text }) + '\n'))
s.on('data', b => {
  buf += b
  const i = buf.indexOf('\n')
  if (i < 0) return
  const r = JSON.parse(buf.slice(0, i)) as { ok?: true; refused?: string }
  s.destroy()
  if (r.ok) console.error(`Told ${place}.`)
  else { console.error(`Could not tell ${place}: ${r.refused}.`); process.exitCode = 1 }
})
s.on('error', e => { console.error(`Kage did not answer: ${e.message}`); process.exitCode = 1 })
