#!/usr/bin/env node
// kage attach <place>: take one thread's session into this terminal, with its whole conversation,
// and give it back to Kage when you quit Claude Code. While you have it, the hub holds the thread:
// its session is closed there, and new tasks for it wait until you quit.
//   kage attach            list recent threads and type a number
//   kage attach support    the one thread whose place contains "support" (several words are fine)
//   kage attach '<link>'   the thread a Slack message link points at ("Copy link" in Slack), with no list
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { connect, type Socket } from 'node:net'
import { DIR } from './home.ts'
import { pickThread } from './pick-thread.ts'

const HOME = process.env.HOME!
// Resume from the hub's working folder: Claude Code finds a session's transcript by folder.
const CWD = process.env.KAGE_CWD || HOME
const SOCK = `${DIR}/router.sock`
if (!existsSync(`${DIR}/kage.db`) || !existsSync(SOCK)) { console.error('Kage is not running: start it with kage start'); process.exit(1) }

const { key, place } = await pickThread(process.argv.slice(2).join(' '))

const WHY = {
  unknown: 'Kage has no session for it',
  held: 'it is already open in another terminal',
} as const
// What attaching stopped, like Esc in Claude Code. The conversation is all there; the turn just ended early.
const CUT = {
  busy: 'Kage was mid-turn: that turn stopped. Tell it "continue" to pick it up.',
  asking: 'Kage was waiting on your approval: that request was denied. Ask again here if you want it.',
  watching: 'A timed check was running in it and has ended. Schedules made with the schedule tool keep running after you quit.',
} as const
type Refusal = keyof typeof WHY

// Hold the thread for as long as this connection lives. If the hub restarts, hold it again, so a
// new task cannot start a second copy of this session while you work in it.
let claude: ReturnType<typeof spawn> | undefined
function hold(): Promise<{ id: string; cut?: keyof typeof CUT }> {
  return new Promise((resolve, reject: (e: Error) => void) => {
    const s: Socket = connect(SOCK)
    let buf = ''
    s.on('connect', () => s.write(JSON.stringify({ type: 'hold', key, pid: process.pid }) + '\n'))
    s.on('data', b => {
      buf += b
      const i = buf.indexOf('\n')
      if (i < 0) return
      const r = JSON.parse(buf.slice(0, i)) as { id?: string; cut?: keyof typeof CUT; refused?: Refusal }
      if (r.id) return resolve({ id: r.id, cut: r.cut })
      s.destroy()
      reject(new Error(WHY[r.refused!] ?? r.refused))
    })
    // A socket file with no hub behind it (the hub stopped or crashed). Later tries, after a hub restart, stay quiet and try again.
    s.on('error', () => { if (!claude) reject(new Error('Kage is not running. Start it with kage start')) })
    s.on('close', () => {
      if (claude?.exitCode !== null) return
      setTimeout(() => hold().catch(e => console.error(`\nWarning: Kage restarted and ${place} is no longer held (${e.message}). Quit now: Kage may run this thread too.`)), 1000)
    })
  })
}

const { id, cut } = await hold().catch((e: Error) => { console.error(`Cannot attach to ${place}: ${e.message}.`); process.exit(1) })
if (cut) console.error(CUT[cut])
console.error(`Attached to ${place}. New tasks for it wait for you. Quit Claude Code to give it back to Kage.`)
// The hold must last exactly as long as Claude Code here. Ctrl-c and friends reach both processes;
// Claude Code handles them, and this one waits for it to exit.
for (const sig of ['SIGINT', 'SIGQUIT', 'SIGHUP'] as const) process.on(sig, () => {})
// The hub's copy of the session can take up to 7 s to exit after a cut (the SDK signals it late).
// Resume only once no process runs this session id, so two never write one transcript.
const running = () => spawnSync('pgrep', ['-f', id]).status === 0
for (let waited = 0; running() && waited < 15_000; waited += 250) await new Promise(r => setTimeout(r, 250))
if (running()) { console.error(`Kage's copy of ${place} is still running. Try kage attach again in a minute.`); process.exit(1) }
claude = spawn('claude', ['--resume', id], { stdio: 'inherit', cwd: CWD })
claude.on('exit', code => {
  // The hub drops the hold when this connection closes. If the hub is down right now, drop its file
  // here, so a later process that gets this pid cannot keep the thread held.
  const file = `${DIR}/held/${encodeURIComponent(key)}`
  try { if (readFileSync(file, 'utf8') === String(process.pid)) rmSync(file) } catch {}
  console.error(`${place} is back with Kage.`)
  process.exit(code ?? 0)   // exiting closes the hold, and the hub restarts the thread if tasks waited
})
