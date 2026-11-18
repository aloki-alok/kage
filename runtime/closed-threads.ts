import { log } from './log.ts'
import { answersInThread, blockedTask, OFF_LIMITS, planBlock } from '../core/blocks.ts'
import { senderOf } from '../core/gate.ts'
import type { Task } from '../core/task.ts'
import type { Store } from './store.ts'

const CLOSED = 'closed-threads'

export function closedThreads(o: {
  store: Pick<Store, 'load' | 'save' | 'forget'>
  reset: (key: string) => void
  say: (key: string, t: Task, text: string) => void
  tellOwner: (text: string) => void
}) {
  const closed = () => new Set((o.store.load(CLOSED) as string[] | undefined) ?? [])
  const setClosed = (thread: string, on: boolean) => {
    const s = closed()
    if (on) s.add(thread); else s.delete(thread)
    o.store.save(CLOSED, s.size ? [...s] : undefined)
  }
  const threadOf = (key: string) => key.split('#')[0]!
  return {
    blocked(key: string, turn: Task[], category: string | null) {
      log('the safety check stopped a turn in', key, category ?? '')
      const p = planBlock(turn, category)
      const t = blockedTask(turn)
      o.reset(key)
      o.store.forget(key)
      if (p.close) setClosed(threadOf(key), true)
      if (p.reply && t) o.say(key, t, p.reply)
      if (p.dm) o.tellOwner(p.dm)
    },
    isClosed: (key: string) => closed().has(threadOf(key)),
    closedTo(key: string, t: Task): boolean {
      const thread = threadOf(key)
      if (!closed().has(thread)) return false
      if (senderOf(t) === 'owner' && !t.scheduled) { setClosed(thread, false); return false }
      log('closed thread, task dropped:', key)
      if (answersInThread(t)) o.say(key, t, OFF_LIMITS)
      return true
    },
  }
}
