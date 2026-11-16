// The owner's words, and Kage's answers, for a kagelet's next run.
import type { Store } from './store.ts'
import type { Task } from '../core/task.ts'
import type { Delivery } from '../core/sessions.ts'

// The owner's words typed in a kagelet's thread (no tag) reach its next run, scheduled or run now. Kept in the
// store, so a restart loses none. Only the owner's: anyone else's words in the thread could steer it.
const NOTES = 'kagelet-notes'
export function ownerNotes(store: Pick<Store, 'load' | 'save'>) {
  const all = () => (store.load(NOTES) ?? {}) as Record<string, string[]>
  return {
    // lanes: every kagelet's lane key (the grants). Each lane in this thread keeps the last 10. Returns the lanes it reached.
    wrote(lanes: Iterable<string>, chat: string, thread: string, text: string) {
      const notes = all()
      const hit = [...lanes].filter(k => k.startsWith(`${chat}:${thread}#side-kagelet-`))
      for (const k of hit) notes[k] = [...notes[k] ?? [], text.slice(0, 2000)].slice(-10)
      if (hit.length) store.save(NOTES, notes)
      return hit
    },
    // Kage's answer to one kagelet (tell_kagelet), marked as its manager's.
    tell(lane: string, text: string) {
      const notes = all()
      notes[lane] = [...notes[lane] ?? [], `Kage, your manager: ${text.slice(0, 2000)}`].slice(-10)
      store.save(NOTES, notes)
    },
    // deliver: hands the run over with the notes; false means it never reached a session, so they stay.
    take(key: string, deliver: (text: string) => boolean): string | undefined {
      const notes = all()
      const mine = notes[key]
      if (!mine?.length) return undefined
      const text = `Since your last run, the owner or Kage (your manager) wrote to you. Their words, to follow within your job and your grant:\n${mine.map(t => t.split('\n').map(l => `> ${l}`).join('\n')).join('\n')}`
      if (!deliver(text)) return text
      delete notes[key]
      store.save(NOTES, Object.keys(notes).length ? notes : undefined)
      return text
    },
  }
}

// The scheduler's deliver: a kagelet's run carries its scoreboard (ADR 0016) and what the owner or Kage wrote in its
// thread since its last one. The notes stay when the run never reached a session.
export const kageletDeliver = (notes: ReturnType<typeof ownerNotes>, toSession: (key: string, task: Task) => Delivery, board: (key: string) => string | undefined = () => undefined) => (key: string, task: Task): Delivery => {
  if (!key.includes('#side-kagelet-')) return toSession(key, task)
  const b = board(key)
  const t = b ? { ...task, content: `${b}\n\n${task.content}` } : task
  let r: Delivery | undefined
  notes.take(key, said => (r = toSession(key, { ...t, content: `${t.content}\n\n${said}` })) !== 'failed')
  return r ?? toSession(key, t)
}
