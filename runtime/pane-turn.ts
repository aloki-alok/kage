import { mkdirSync, readFileSync, unwatchFile, watchFile, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { arrive, endTurn, NO_TURN, turnSender } from '../core/pane-turn.ts'
import { senderFile } from '../core/guards.ts'
import type { Task } from '../core/task.ts'

export const turnMarks = (dir: string, thread: string) => ({ step: `${senderFile(dir, thread)}.step`, stop: `${senderFile(dir, thread)}.stop` })

export function paneTurn(o: { dir: string; thread: string; show: (t: Task) => void; pollMs?: number }) {
  const file = senderFile(o.dir, o.thread), marks = turnMarks(o.dir, o.thread)
  let turn = NO_TURN
  const write = () => {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    writeFileSync(file, turnSender(turn), { mode: 0o600 })
  }
  const take = (t: Task) => {
    const r = arrive(turn, t, Date.now())
    turn = r.turn
    write()
    o.show(r.shown)
  }
  const ended = (now: { mtimeMs: number }, before: { mtimeMs: number }) => {
    if (now.mtimeMs <= before.mtimeMs) return
    let lastStep = 0
    try { lastStep = Number(readFileSync(marks.step, 'utf8')) || 0 } catch {}
    const r = endTurn(turn, lastStep)
    turn = r.turn
    write()
    for (const t of r.send) take(t)
  }
  watchFile(marks.stop, { interval: o.pollMs ?? 250 }, ended)
  return {
    sender: () => turn.tasks.length ? turnSender(turn) : undefined,
    arrive: take,
    close: () => unwatchFile(marks.stop, ended),
  }
}
