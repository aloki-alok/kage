import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { withoutInvisible } from '../core/gate.ts'
import type { Task } from '../core/task.ts'

export type Inbox = AsyncIterable<SDKUserMessage> & { push(m: SDKUserMessage): void; close(): void; drain(): SDKUserMessage[] }
export function makeInbox(items: SDKUserMessage[] = []): Inbox {
  let wake: (() => void) | undefined, closed = false
  return {
    push(m) { items.push(m); wake?.() },
    close() { closed = true; wake?.() },
    drain: () => items.splice(0),
    async *[Symbol.asyncIterator]() {
      while (true) {
        while (items.length) yield items.shift()!
        if (closed) return
        await new Promise<void>(r => { wake = r })
        wake = undefined
      }
    },
  }
}

export const userMessage = (m: Task, uuid: string) => ({ type: 'user', message: { role: 'user', content: channelTag(m) }, parent_tool_use_id: null, uuid }) as SDKUserMessage

export function channelTag(m: Task) {
  const attr = (v: string) => withoutInvisible(v).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;')
  const attrs = Object.entries({ channel: m.meta.channel, thread_ts: m.meta.thread_ts, place: m.meta.place, permalink: m.meta.permalink })
    .map(([k, v]) => `${k}="${attr(v)}"`).join(' ')
  return `<channel source="kage" ${attrs}>\n${withoutInvisible(m.content).replace(/<(\/?)channel/gi, '&lt;$1channel')}\n</channel>`
}
