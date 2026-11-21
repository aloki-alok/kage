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
  const transcript = (id: string) => `${o.project}/${id}.jsonl`
  const rotating = (key: string, lines: string[]) => o.ready(key) === 'ready' && rotateDue(key, contextTokens(lines), o.limit())
  return {
    sessionOf(key: string) {
      const id = o.idOf(key)
      if (!id) return undefined
      return { id, resumable: o.hasTranscript(id) && !rotating(key, tailOf(transcript(id))) }
    },
    before(key: string, task: Task): Task {
      const id = o.idOf(key)
      if (!id || task.deltaOf === id) return task
      const lines = tailOf(transcript(id))
      if (!rotating(key, lines)) return task
      const { count, chars } = o.carry()
      const carry = rotateCarry(sentTexts(lines), count, chars, transcript(id))
      o.reset(key)
      return { ...task, content: `${carry}\n${task.content}` }
    },
  }
}
