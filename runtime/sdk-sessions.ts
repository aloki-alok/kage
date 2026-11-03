// The session runtime on the Agent SDK: each thread is one long-lived query() inside the hub, with
// Kage's tools served in-process. It fills the same Windows interface as tmux-windows.ts, so the
// dispatcher does not know which one runs. Unlike a tmux pane, a session here lives and dies with
// the hub process, crons included.
// The SDK comes in as an argument: the hub imports it only when this runtime is on, so a tmux-only
// install needs no SDK.
import type { createSdkMcpServer, Options, Query, SDKMessage, SDKUserMessage, tool } from '@anthropic-ai/claude-agent-sdk'
import { log } from '../config.ts'
import { ownerMemoryRefusal, privateToolRefusal } from '../core/guards.ts'
import { liveCronJobs, type Dispatcher, type Windows } from '../core/sessions.ts'
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
  sender?: 'owner' | 'teammate'                 // who sent the latest task: the guard hook reads it
  state: 'idle' | 'running' | 'requires_action'
  last: number
  stopped: boolean
  run?: { q: Query; inbox: Inbox; send: (m: ToSession) => void; started: number }
  asks: Map<string, (b: 'allow' | 'deny') => void>
  jobs: { timestamp: string; text: string }[]   // tool results that made or cancelled a cron job
}

export function sdkWindows(o: {
  sdk: Sdk
  hub: () => Dispatcher<ToSession>
  tools: (key: string, send: (m: { type: 'mail'; text: string }) => void) => Kage   // one set per thread
  hasTranscript: (id: string) => boolean
  toHub: (key: string, m: { type: 'mail'; text: string }) => void
  options: Options                                 // cwd, settings, settingSources, the claude binary
  ownerMemory: string
  onStart?: () => void                            // a new id may have been minted: save the map
  restartMs?: number
}) {
  const sessions = new Map<string, Session>()
  // The tools the owner approved for every pane in start.sh.
  const ALLOWED = ['reply', 'edit_message', 'delete_message', 'schedule', 'unschedule', 'schedules'].map(t => `mcp__kage__${t}`)

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
        allowedTools: [...o.options.allowedTools ?? [], ...ALLOWED],
        // Its jobs die with the session; the schedule tool replaces it.
        disallowedTools: [...o.options.disallowedTools ?? [], 'CronCreate', 'CronDelete', 'CronList'],
        // Claude Code sends session_state_changed, which busy() reads, only when asked.
        env: { ...env, CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '1' },
        canUseTool: (name, input, x) => ask(key, s, name, x.title ?? x.description ?? '', input, x.signal),
        // The same rules as private-data-guard.ts, in-process. A failed check blocks the call.
        hooks: {
          PreToolUse: [{
            onFailure: 'block',
            hooks: [async input => {
              const i = input as { tool_name: string; tool_input?: Record<string, string> }
              const reason = privateToolRefusal(i.tool_name, s.sender) ?? ownerMemoryRefusal(i.tool_name, i.tool_input ?? {}, o.ownerMemory)
              return reason ? { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } } : {}
            }],
          }],
        },
      },
    })
    const send = (m: ToSession) => {
      if (m.type === 'verdict') { s.asks.get(m.request_id)?.(m.behavior); return }
      s.sender = m.fromOwner && m.meta.channel !== 'email' ? 'owner' : 'teammate'
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
          else if (m.type === 'result' && !sawState) s.state = 'idle'
          else if (m.type === 'user') s.jobs.push(...cronMentions(m))
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
      s.kage.askOwner({ id, tool, description, preview: JSON.stringify(input, null, 2) }).then(
        () => { if (s.asks.has(id)) o.hub().permission(key, id) },
        e => { log('permission prompt failed', e?.data?.error ?? e); done('deny') },
      )
    })
  }

  const denyAll = (s: Session) => { for (const done of [...s.asks.values()]) done('deny') }

  const windows: Windows = {
    start(key, id) {
      const s: Session = sessions.get(key) ?? {
        id, state: 'idle', last: 0, stopped: false, asks: new Map(), jobs: [],
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
      return s.state !== 'idle' ? true : liveCronJobs(s.jobs, s.run?.started ?? Infinity, Date.now()).length > 0 ? 'watching' : false
    },
  }
  return { windows, running: () => new Set([...sessions.values()].map(s => s.id)) }
}

// Tool results that mention a job (CronCreate, CronDelete), stamped now, for liveCronJobs.
function cronMentions(m: SDKMessage): { timestamp: string; text: string }[] {
  const content = (m as { message?: { content?: unknown } }).message?.content
  if (!Array.isArray(content)) return []
  return content
    .filter(b => b?.type === 'tool_result')
    .map(b => typeof b.content === 'string' ? b.content : (b.content ?? []).map((c: { text?: string }) => c?.text ?? '').join(''))
    .filter((text: string) => text.includes(' job '))
    .map((text: string) => ({ timestamp: new Date().toISOString(), text }))
}

// A task as Claude Code shows a channel message. Attributes are escaped, and the content cannot
// open or close a channel tag of its own.
export function channelTag(m: Task) {
  const attr = (v: string) => v.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;')
  const attrs = Object.entries({ channel: m.meta.channel, thread_ts: m.meta.thread_ts, place: m.meta.place, permalink: m.meta.permalink })
    .map(([k, v]) => `${k}="${attr(v)}"`).join(' ')
  return `<channel source="kage" ${attrs}>\n${m.content.replace(/<(\/?)channel/gi, '&lt;$1channel')}\n</channel>`
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
