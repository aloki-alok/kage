import { closeSync, openSync, readSync } from 'node:fs'
import { topicOf } from '../core/board.ts'

export function topicReader(project: string) {
  const topics = new Map<string, { topic?: string; at: number }>()
  function firstAsk(id: string): string | undefined {
    let fd: number | undefined
    try {
      fd = openSync(`${project}/${id}.jsonl`, 'r')
      const buf = Buffer.alloc(65_536), head = buf.subarray(0, readSync(fd, buf, 0, buf.length, 0)).toString('utf8')
      const line = head.split('\n').find(l => l.includes('"type":"user"'))
      const c = line && (JSON.parse(line) as { message?: { content?: string | { type: string; text?: string }[] } }).message?.content
      return topicOf(typeof c === 'string' ? c : c?.find(x => x.type === 'text')?.text ?? '')
    } catch { return undefined } finally { if (fd !== undefined) closeSync(fd) }
  }
  return (id: string, now = Date.now()) => {
    const seen = topics.get(id)
    if (seen?.topic || (seen && now - seen.at < 10_000)) return seen.topic
    const topic = firstAsk(id)
    topics.set(id, { topic, at: now })
    return topic
  }
}
