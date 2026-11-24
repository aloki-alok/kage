#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { connect, type Socket } from 'node:net'
import { asOwner, CWD, DIR } from './home.ts'
import { pickThread } from './pick-thread.ts'
import { errVoice } from './voice.ts'

const SOCK = `${DIR}/router.sock`
if (!existsSync(`${DIR}/kage.db`) || !existsSync(SOCK)) { console.error(errVoice.says("I'm not running. Start me with kage start.")); process.exit(1) }

const { key, place } = await pickThread(process.argv.slice(2).join(' '))

const WHY = {
  unknown: 'Kage has no session for it',
  held: 'it is already open in another terminal',
} as const
const CUT = {
  busy: 'Kage was mid-turn: that turn stopped. Tell it "continue" to pick it up.',
  asking: 'Kage was waiting on your approval: that request was denied. Ask again here if you want it.',
  watching: 'A timed check was running in it and has ended. Schedules made with the schedule tool keep running after you quit.',
} as const
type Refusal = keyof typeof WHY

let claude: ReturnType<typeof spawn> | undefined
function hold(): Promise<{ id: string; cut?: keyof typeof CUT }> {
  return new Promise((resolve, reject: (e: Error) => void) => {
    const s: Socket = connect(SOCK)
    let buf = ''
    s.on('connect', () => s.write(JSON.stringify(asOwner({ type: 'hold', key, pid: process.pid })) + '\n'))
    s.on('data', b => {
      buf += b
      const i = buf.indexOf('\n')
      if (i < 0) return
      const r = JSON.parse(buf.slice(0, i)) as { id?: string; cut?: keyof typeof CUT; refused?: Refusal }
      if (r.id) return resolve({ id: r.id, cut: r.cut })
      s.destroy()
      reject(new Error(WHY[r.refused!] ?? r.refused))
    })
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
for (const sig of ['SIGINT', 'SIGQUIT', 'SIGHUP'] as const) process.on(sig, () => {})
const running = () => spawnSync('pgrep', ['-f', id]).status === 0
for (let waited = 0; running() && waited < 15_000; waited += 250) await new Promise(r => setTimeout(r, 250))
if (running()) { console.error(`Kage's copy of ${place} is still running. Try kage attach again in a minute.`); process.exit(1) }
claude = spawn('claude', ['--resume', id], { stdio: 'inherit', cwd: CWD })
claude.on('exit', code => {
  const file = `${DIR}/held/${encodeURIComponent(key)}`
  try { if (readFileSync(file, 'utf8') === String(process.pid)) rmSync(file) } catch {}
  console.error(`${place} is back with Kage.`)
  process.exit(code ?? 0)
})
