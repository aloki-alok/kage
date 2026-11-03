#!/usr/bin/env node
// kage attach <place>: take one thread's session into this terminal, with its whole conversation,
// and give it back to Kage when you quit Claude Code. While you have it, the hub holds the thread:
// its session is closed there, and new tasks for it wait until you quit.
//   ./setup.sh attach            list recent threads
//   ./setup.sh attach acme       the one thread whose place contains "acme"
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { connect, type Socket } from 'node:net'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const HOME = process.env.HOME!
const DIR = dirname(process.env.KAGE_ENV || `${HOME}/.config/kage/env`)
// Resume from the hub's working folder: Claude Code finds a session's transcript by folder.
const CWD = process.env.KAGE_CWD || HOME
const SOCK = `${DIR}/router.sock`
if (!existsSync(`${DIR}/kage.db`) || !existsSync(SOCK)) { console.error('Kage is not running: start it with ./start.sh'); process.exit(1) }

const db = new DatabaseSync(`${DIR}/kage.db`, { readOnly: true })
const rows = db.prepare(`select s.key, coalesce(c.place, s.key) as place from sessions s
  left join conversations c using (key) order by c.last_seen desc nulls last`).all() as { key: string; place: string }[]
const want = process.argv[2]?.toLowerCase()
const found = want ? rows.filter(r => r.key === process.argv[2] || r.place.toLowerCase().includes(want)) : []
if (found.length !== 1) {
  console.error(want ? `${found.length} threads match "${process.argv[2]}". Pick one:` : 'Pick a thread:')
  for (const r of (found.length ? found : rows).slice(0, 20)) console.error(`  ${r.place}   (${r.key})`)
  process.exit(1)
}
const { key, place } = found[0]!

const WHY = {
  unknown: 'Kage has no session for it',
  held: 'it is already open in another terminal',
  busy: 'Kage is working in it right now. Try again when it is quiet (./setup.sh watch shows it)',
  asking: 'Kage is waiting on your approval in it',
} as const

// Hold the thread for as long as this connection lives. If the hub restarts, hold it again, so a
// new task cannot start a second copy of this session while you work in it.
let claude: ReturnType<typeof spawn> | undefined
function hold(): Promise<string> {
  return new Promise((resolve, reject) => {
    const s: Socket = connect(SOCK)
    let buf = ''
    s.on('connect', () => s.write(JSON.stringify({ type: 'hold', key, pid: process.pid }) + '\n'))
    s.on('data', b => {
      buf += b
      const i = buf.indexOf('\n')
      if (i < 0) return
      const r = JSON.parse(buf.slice(0, i)) as { id?: string; refused?: keyof typeof WHY }
      if (r.id) resolve(r.id)
      else reject(new Error(WHY[r.refused!] ?? r.refused))
    })
    s.on('error', () => {})
    s.on('close', () => {
      if (claude?.exitCode !== null) return
      setTimeout(() => hold().catch(e => console.error(`\nWarning: Kage restarted and ${place} is no longer held (${e.message}). Quit now: Kage may run this thread too.`)), 1000)
    })
  })
}

let id: string
try { id = await hold() } catch (e) { console.error(`Cannot attach to ${place}: ${(e as Error).message}.`); process.exit(1) }
console.error(`Attached to ${place}. Quit Claude Code to give it back to Kage.`)
// The hold must last exactly as long as Claude Code here. Ctrl-c and friends reach both processes;
// Claude Code handles them, and this one waits for it to exit.
for (const sig of ['SIGINT', 'SIGQUIT', 'SIGHUP'] as const) process.on(sig, () => {})
// ponytail: a fixed wait for the hub's copy of the session to exit after it was closed; wait on
// its pid instead if an overlap ever shows up in the transcript.
await new Promise(r => setTimeout(r, 2000))
claude = spawn('claude', ['--resume', id], { stdio: 'inherit', cwd: CWD })
claude.on('exit', code => {
  // The hub drops the hold when this connection closes. If the hub is down right now, drop its file
  // here, so a later process that gets this pid cannot keep the thread held.
  const file = `${DIR}/held/${encodeURIComponent(key)}`
  try { if (readFileSync(file, 'utf8') === String(process.pid)) rmSync(file) } catch {}
  console.error(`${place} is back with Kage.`)
  process.exit(code ?? 0)   // exiting closes the hold, and the hub restarts the thread if tasks waited
})
