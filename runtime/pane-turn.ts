import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { arrive, endTurn, NO_TURN, turnSender } from '../core/pane-turn.ts'
import { senderFile } from '../core/guards.ts'
import type { Task } from '../core/task.ts'

const turnMarks = (dir: string, thread: string) => ({ step: `${senderFile(dir, thread)}.step`, stop: `${senderFile(dir, thread)}.stop` })
export function markTurn(dir: string, thread: string, mark: 'step' | 'stop') {
  const file = turnMarks(dir, thread)[mark]
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  writeFileSync(file, String(Date.now()), { mode: 0o600 })
}

export function paneTurn(o: { dir: string; thread: string; show: (t: Task) => void; pollMs?: number }) {
  const file = senderFile(o.dir, o.thread), marks = turnMarks(o.dir, o.thread)
  const markAt = (f: string) => { try { return Number(readFileSync(f, 'utf8')) || 0 } catch { return 0 } }
  let turn = NO_TURN, seenStop = markAt(marks.stop)
  const write = () => {
    if (!turn.tasks.length) return
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    writeFileSync(file, turnSender(turn), { mode: 0o600 })
  }
  const take = (t: Task) => {
    ended()
    const r = arrive(turn, t, Date.now(), markAt(marks.step) > seenStop)
    turn = r.turn
    write()
    o.show(r.shown)
  }
  const ended = () => {
    const stoppedAt = markAt(marks.stop)
    if (stoppedAt <= seenStop) return
    seenStop = stoppedAt
    const r = endTurn(turn, markAt(marks.step), stoppedAt)
    turn = r.turn
    write()
    for (const t of r.send) take(t)
  }
  const poll = setInterval(ended, o.pollMs ?? 250)
  return {
    sender: () => turn.tasks.length ? turnSender(turn) : undefined,
    arrive: take,
    close: () => clearInterval(poll),
  }
}
