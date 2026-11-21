import { statSync } from 'node:fs'
import { contextTokens, rotateCarry, rotateDue } from '../core/thread-rotate.ts'
import { sentTexts } from '../core/transcript.ts'
import type { Task } from '../core/task.ts'
import { newLines } from './transcript-tail.ts'

const TAIL_BYTES = 1_000_000

type RotatorOptions = {
  project: string
  limit: () => number
  carry: () => { count: number; chars: number }
  idOf: (key: string) => string | undefined
  hasTranscript: (id: string) => boolean
  ready: (key: string) => 'ready' | 'busy' | 'blocked'
  reset: (key: string) => void
}

function tailOf(file: string): string[] {
  let size = 0
  try { size = statSync(file).size } catch { return [] }
  return newLines(file, Math.max(0, size - TAIL_BYTES)).lines
}

export function threadRotator(o: RotatorOptions) {
  const promisedDelta = new Map<string, string>()
  const transcript = (id: string) => `${o.project}/${id}.jsonl`
  const due = (key: string, id: string) => rotateDue(key, contextTokens(tailOf(transcript(id))), o.limit())
  return {
    sessionOf(key: string) {
      const id = o.idOf(key)
      if (!id) return undefined
      const resumable = o.hasTranscript(id) && !due(key, id)
      if (resumable) promisedDelta.set(key, id)
      else promisedDelta.delete(key)
      return { id, resumable }
    },
    before(key: string, task: Task): Task {
      const promised = promisedDelta.get(key)
      promisedDelta.delete(key)
      const id = o.idOf(key)
      if (!id || promised === id || o.ready(key) !== 'ready') return task
      const lines = tailOf(transcript(id))
      if (!rotateDue(key, contextTokens(lines), o.limit())) return task
      const { count, chars } = o.carry()
      const carry = rotateCarry(sentTexts(lines), count, chars, transcript(id))
      o.reset(key)
      return { ...task, content: `${carry}\n${task.content}` }
    },
  }
}
