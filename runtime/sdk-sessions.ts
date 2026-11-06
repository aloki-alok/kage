// The session runtime on the Agent SDK: each thread is one long-lived query() inside the hub, with
// Kage's tools served in-process. It fills the same Runner interface as tmux-panes.ts, so the
// dispatcher does not know which one runs. Unlike a tmux pane, a session here lives and dies with
// the hub process, crons included.
// The SDK comes in as an argument: the hub imports it only when this runtime is on, so a tmux-only
// install needs no SDK.
import type { createSdkMcpServer, Options, Query, SDKMessage, SDKUserMessage, tool } from '@anthropic-ai/claude-agent-sdk'
import { log } from '../config.ts'
import { senderOf, withoutInvisible, type Sender } from '../core/gate.ts'
import { ownerMemoryRefusal, privateToolRefusal, voiceToolRefusal } from '../core/guards.ts'
import { approvalPreview } from '../core/preview.ts'
import type { Dispatcher, Runner } from '../core/sessions.ts'
import type { sessionTools } from './kage-tools.ts'
import type { Task, ToSession } from './protocol.ts'

type Kage = ReturnType<typeof sessionTools>
export type Sdk = {
  query: (p: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => Query
  createSdkMcpServer: typeof createSdkMcpServer
  tool: typeof tool
}
type Session = {
  id: string
  kage: Kage
  sender?: Sender               // who sent the latest task: the guard hook reads it
  state: 'idle' | 'running' | 'requires_action'
  last: number
  stopped: boolean
  run?: { q: Query; inbox: Inbox; send: (m: ToSession) => void; started: number }
  asks: Map<string, (b: 'allow' | 'deny') => void>
}

export function sdkSessions(o: {
  sdk: Sdk
  hub: () => Dispatcher<ToSession>
  tools: (key: string, send: (m: { type: 'mail' | 'wa' | 'voice'; text: string }) => void) => Kage   // one set per thread
  hasTranscript: (id: string) => boolean
  toHub: (key: string, m: { type: 'mail' | 'wa' | 'voice'; text: string }) => void
  options: Options                                 // cwd, settings, settingSources, the claude binary
  ownerMemory: string
  onStart?: () => void                            // a new id may have been minted: save the map
  onResult?: (key: string, totalUsd: number) => void   // a turn ended: the session's running cost so far
  restartMs?: number
}) {
  const sessions = new Map<string, Session>()
  // Kage's own tools, approved for every session (start.sh does the same for panes). Approved in canUseTool, not
  // allowedTools, which would skip the callback and makes the SDK warn on every session.
  const ALLOWED = ['reply', 'edit_message', 'delete_message', 'send_file', 'message_people', 'schedule', 'unschedule', 'schedules'].map(t => `mcp__kage__${t}`)

  function open(key: string, s: Session, carried: SDKUserMessage[] = []) {
    const inbox = makeInbox(carried)
    const server = o.sdk.createSdkMcpServer({
      name: 'kage', instructions: s.kage.instructions,
      tools: s.kage.tools.map(t => o.sdk.tool(t.name, t.description, t.shape, async args => {
        const r = await t.run(args)
        return { isError: r.isError, content: [{ type: 'text' as const, text: r.text }] }
      })),
    })
    const { KAGE_THREAD: _, ...env } = process.env   // with it, the kage plugin's own channel would take the thread
    const q = o.sdk.query({
      prompt: inbox,
      options: {
        ...o.options,
        ...(o.hasTranscript(s.id) ? { resume: s.id } : { sessionId: s.id }),
        systemPrompt: { type: 'preset', preset: 'claude_code' },
        mcpServers: { ...o.options.mcpServers, kage: server },
        // Its jobs die with the session; the schedule tool replaces it.
        disallowedTools: [...o.options.disallowedTools ?? [], 'CronCreate', 'CronDelete', 'CronList'],
        // Claude Code sends session_state_changed, which busy() reads, only when asked.
        env: { ...env, CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '1' },
        canUseTool: (name, input, x) => ALLOWED.includes(name) ? Promise.resolve({ behavior: 'allow' as const, updatedInput: input }) : ask(key, s, name, x.title ?? x.description ?? '', input, x.signal),
        // The same rules as private-data-guard.ts, in-process. A failed check blocks the call.
        hooks: {
          PreToolUse: [{
            onFailure: 'block',
            hooks: [async input => {
              const i = input as { tool_name: string; tool_input?: Record<string, string> }
              const reason = privateToolRefusal(i.tool_name, s.sender) ?? voiceToolRefusal(i.tool_name, s.sender) ?? ownerMemoryRefusal(i.tool_name, i.tool_input ?? {}, o.ownerMemory)
              return reason ? { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } } : {}
            }],
          }],
        },
      },
    })
    const send = (m: ToSession) => {
      if (m.type === 'verdict') { s.asks.get(m.request_id)?.(m.behavior); return }
      s.sender = senderOf(m)
      s.kage.onTask(m)
      s.state = 'running'
      s.last = Date.now()
      inbox.push({ type: 'user', message: { role: 'user', content: channelTag(m) }, parent_tool_use_id: null } as SDKUserMessage)
    }
    s.run = { q, inbox, send, started: Date.now() }
    let connected = false
    // Connected once Claude Code has started: the handshake, or failing that its first message. A
    // process that never starts leaves its tasks with the dispatcher, which reports them after connectMs.
    const connect = () => { if (!connected && !s.stopped) connected = o.hub().connect(key, send) }
    q.initializationResult().then(connect, () => {})
    void (async () => {
      let sawState = false
      try {
        for await (const m of q as AsyncIterable<SDKMessage>) {
          s.last = Date.now()
          connect()
          if (m.type === 'system' && m.subtype === 'session_state_changed') { sawState = true; s.state = m.state }
          // A Claude Code that never sends the state event: the turn's result is the best idle signal.
          if (m.type === 'result') o.onResult?.(key, m.total_cost_usd)
          if (m.type === 'result' && !sawState) s.state = 'idle'
        }
      } catch (e) { log('session ended', key, e) }
      // The Claude process is gone: its open approvals go with it. Unless the dispatcher closed it,
      // it comes back on the same conversation, like the shell loop in a tmux pane, and takes the
      // tasks this process never read.
      denyAll(s)
      s.state = 'idle'
      if (s.stopped) return
      o.hub().disconnect(key, send)
      const unread = inbox.drain()
      setTimeout(() => { if (!s.stopped) open(key, s, unread) }, o.restartMs ?? 3000)
    })()
  }

  function ask(key: string, s: Session, tool: string, description: string, input: Record<string, unknown>, signal: AbortSignal) {
    const id = requestId()
    return new Promise<{ behavior: 'allow'; updatedInput: Record<string, unknown> } | { behavior: 'deny'; message: string }>(resolve => {
      const done = (b: 'allow' | 'deny') => {
        s.asks.delete(id)
        resolve(b === 'allow' ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: 'The owner did not approve this.' })
      }
      if (signal.aborted) return done('deny')
      s.asks.set(id, done)
      signal.addEventListener('abort', () => done('deny'), { once: true })
      // Open with the dispatcher only once the owner can see it: an open approval holds the slot,
      // and a prompt that never posted can never be answered.
      s.kage.askOwner({ id, tool, description, preview: approvalPreview(tool, input) }).then(
        () => { if (s.asks.has(id)) o.hub().permission(key, id) },
        e => { log('permission prompt failed', e?.data?.error ?? e); done('deny') },
      )
    })
  }

  const denyAll = (s: Session) => { for (const done of [...s.asks.values()]) done('deny') }

  const runner: Runner = {
    start(key, id) {
      const s: Session = sessions.get(key) ?? {
        id, state: 'idle', last: 0, stopped: false, asks: new Map(),
        kage: o.tools(key, m => o.toHub(key, m)),
      }
      Object.assign(s, { id, stopped: false })
      try { open(key, s) } catch (e) { sessions.delete(key); throw e }
      sessions.set(key, s)
      o.onStart?.()
    },
    stop(key) {
      const s = sessions.get(key)
      if (!s) return
      s.stopped = true
      denyAll(s)
      s.run?.inbox.close()
      s.run?.q.close()
      sessions.delete(key)
    },
    lastActivity: key => sessions.get(key)?.last ?? 0,
    // 'idle' comes only after the turn and any background agents finish. A cron job lives only in
    // this Claude process, so a session that holds one stays.
    busy(key) {
      const s = sessions.get(key)
      if (!s) return false
      return s.state !== 'idle'
    },
  }
  return { runner, running: () => new Set([...sessions.values()].map(s => s.id)) }
}

// A task as Claude Code shows a channel message. Attributes are escaped, and the content cannot
// open or close a channel tag of its own.
export function channelTag(m: Task) {
  const attr = (v: string) => withoutInvisible(v).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;')
  const attrs = Object.entries({ channel: m.meta.channel, thread_ts: m.meta.thread_ts, place: m.meta.place, permalink: m.meta.permalink })
    .map(([k, v]) => `${k}="${attr(v)}"`).join(' ')
  return `<channel source="kage" ${attrs}>\n${withoutInvisible(m.content).replace(/<(\/?)channel/gi, '&lt;$1channel')}\n</channel>`
}

// Approval ids look like Claude Code's: five letters, no "l", which the gate's "yes <id>" expects.
function requestId() {
  const abc = 'abcdefghijkmnopqrstuvwxyz'
  return Array.from({ length: 5 }, () => abc[Math.floor(Math.random() * abc.length)]).join('')
}

type Inbox = AsyncIterable<SDKUserMessage> & { push(m: SDKUserMessage): void; close(): void; drain(): SDKUserMessage[] }
// The session's input: tasks go in as they arrive, and the query reads them as one long stream.
function makeInbox(items: SDKUserMessage[] = []): Inbox {
  let wake: (() => void) | undefined
  let closed = false
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
