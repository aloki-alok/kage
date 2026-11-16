// An Agent SDK session's input (runtime/sdk-sessions.ts): tasks go in as they arrive, and the query reads them as one long stream.
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'

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
