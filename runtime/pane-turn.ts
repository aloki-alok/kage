import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { senderOf, type Sender } from '../core/gate.ts'
import { senderFile } from '../core/guards.ts'
import type { Task } from '../core/task.ts'

export function paneTurn(o: { dir: string; thread: string; show: (t: Task) => void }) {
  const file = senderFile(o.dir, o.thread)
  let sender: Sender | undefined
  return {
    sender: () => sender,
    arrive(t: Task) {
      sender = senderOf({ fromOwner: t.fromOwner === true, meta: t.meta })
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
      writeFileSync(file, sender, { mode: 0o600 })
      o.show(t)
    },
  }
}
