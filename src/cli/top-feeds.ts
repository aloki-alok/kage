import { readFileSync, statSync } from 'node:fs'
import { watchingNext } from '../core/board.ts'
import { transcriptLine } from '../core/transcript.ts'
import { newLines } from '../runtime/transcript-tail.ts'
import type { Step } from './top-draw.ts'

type Feed = { file: string; offset: number; steps: Step[]; changed: number }

export function transcriptFeeds(project: string, idOf: (key: string) => string | undefined) {
  const watchCache = new Map<string, { at: number; next: number | undefined }>()
  function watchNext(key: string, now: number): number | undefined {
    const c = watchCache.get(key)
    if (c && now - c.at < 30_000) return c.next
    let value: number | undefined
    try { value = watchingNext(readFileSync(`${project}/${idOf(key)}.jsonl`, 'utf8').split('\n'), now) } catch {}
    watchCache.set(key, { at: now, next: value })
    return value
  }

  const feeds = new Map<string, Feed>()
  function follow(key: string) {
    const id = idOf(key)
    if (!id) return
    const file = `${project}/${id}.jsonl`
    const prev = feeds.get(key)
    const first = !prev || prev.file !== file
    let size = 0
    if (first) try { size = statSync(file).size } catch {}
    const f = first ? { file, offset: Math.max(0, size - 64_000), steps: [], changed: 0 } : prev
    if (first) feeds.set(key, f)
    const r = newLines(file, f.offset)
    f.offset = r.offset
    for (const raw of r.lines) {
      const text = transcriptLine(raw)
      if (!text) continue
      let at = Date.now()
      try { at = Date.parse(JSON.parse(raw).timestamp) || at } catch {}
      for (const t of text.split('\n')) f.steps.push({ at, text: t })
      if (!first) f.changed = Date.now()
    }
    if (f.steps.length > 300) f.steps = f.steps.slice(-300)
  }
  return { feeds, follow, watchNext }
}
