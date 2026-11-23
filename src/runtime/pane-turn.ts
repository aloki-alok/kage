import { closeSync, mkdirSync, openSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { arrive, endTurn, resumedTurn, turnSender, turnStarted } from '../core/pane-turn.ts'
import { senderFile } from '../core/guards.ts'
import type { Task } from '../core/task.ts'

const turnMarks = (dir: string, thread: string) => ({ step: `${senderFile(dir, thread)}.step`, stop: `${senderFile(dir, thread)}.stop`, transcript: `${senderFile(dir, thread)}.transcript` })
export function markTurn(dir: string, thread: string, mark: 'step' | 'stop', transcript?: string) {
  const file = turnMarks(dir, thread)[mark]
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const at = turnMarks(dir, thread).transcript
  if (mark === 'stop') try { writeFileSync(at, JSON.stringify({ path: transcript, size: statSync(transcript!).size }), { mode: 0o600 }) } catch { rmSync(at, { force: true }) }
  writeFileSync(file, String(Date.now()), { mode: 0o600 })
}

export function paneTurn(o: { dir: string; thread: string; show: (t: Task) => void; pollMs?: number }) {
  const file = senderFile(o.dir, o.thread), marks = turnMarks(o.dir, o.thread)
  const markAt = (f: string) => { try { return Number(readFileSync(f, 'utf8')) || 0 } catch { return 0 } }
  const startedSinceStop = () => {
    try {
      const at = JSON.parse(readFileSync(marks.transcript, 'utf8')) as { path: string; size: number }
      const grew = statSync(at.path).size - at.size
      if (grew <= 0) return false
      const fd = openSync(at.path, 'r'), buf = Buffer.alloc(grew)
      try { readSync(fd, buf, 0, grew, at.size) } finally { closeSync(fd) }
      return turnStarted(buf.toString('utf8'))
    } catch { return false }
  }
  let lastSender = ''
  try { lastSender = readFileSync(file, 'utf8').trim() } catch {}
  let turn = resumedTurn(lastSender || 'owner'), seenStop = markAt(marks.stop)
  const write = () => {
    if (!turn.tasks.length) return
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    writeFileSync(file, turnSender(turn), { mode: 0o600 })
  }
  const take = (t: Task) => {
    ended()
    const r = arrive(turn, t, Date.now(), markAt(marks.step) > seenStop || startedSinceStop())
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
