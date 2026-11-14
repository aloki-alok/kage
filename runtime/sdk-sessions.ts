// The session runtime on the Agent SDK: each thread is one long-lived query() inside the hub, with
// Kage's tools served in-process. It fills the same Runner interface as tmux-panes.ts, so the
// dispatcher does not know which one runs. Unlike a tmux pane, a session here lives and dies with
// the hub process, crons included.
// The SDK comes in as an argument: the hub imports it only when this runtime is on, so a tmux-only
// install needs no SDK.
import type { createSdkMcpServer, EffortLevel, Options, Query, SDKMessage, SDKUserMessage, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { log } from '../config.ts'
import { senderOf, withoutInvisible, type Sender } from '../core/gate.ts'
import { ownerMemoryRefusal, privateToolRefusal, slackSendRefusal, voiceToolRefusal } from '../core/guards.ts'
import { DEFAULT_GRANT, grantRefusal } from '../core/kagelets.ts'
import { approvalPreview } from '../core/preview.ts'
import type { Dispatcher, Runner } from '../core/sessions.ts'
import type { sessionTools } from './kage-tools.ts'
import type { Limit } from './limit-pause.ts'
import type { Task, ToSession } from './protocol.ts'

type Kage = ReturnType<typeof sessionTools>
export type Sdk = {
  query: (p: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => Query
  createSdkMcpServer: typeof createSdkMcpServer
  tool: typeof tool
}
type Pick = { model?: string; effort?: EffortLevel }
type Session = {
  id: string
  kage: Kage
  sender?: Sender               // who sent the latest task: the guard hook reads it
  turn: { task: Task; mid: boolean }[]   // tasks the current turn may have read: a safety block reports them. mid: sent mid-turn
  state: 'idle' | 'running' | 'requires_action'
  last: number
  stopped: boolean
  run?: { q: Query; inbox: Inbox; send: (m: ToSession) => void; started: number }
  asks: Map<string, (b: 'allow' | 'deny') => void>
}

export function sdkSessions(o: {
  sdk: Sdk
  hub: () => Dispatcher<ToSession>
  // One set per thread. approve: the owner's card from inside a tool, true only on their yes.
  tools: (key: string, send: (m: { type: 'mail' | 'wa' | 'voice'; text: string }) => void, approve: (tool: string, description: string, input: Record<string, unknown>) => Promise<boolean>) => Kage
  hasTranscript: (id: string) => boolean
  toHub: (key: string, m: { type: 'mail' | 'wa' | 'voice'; text: string }) => void
  options: Options                                 // cwd, settings, settingSources, the claude binary
  ownerMemory: string
  onStart?: () => void                            // a new id may have been minted: save the map
  onResult?: (key: string, totalUsd: number, resumed: boolean) => void   // a turn ended: the session's running cost so far
  onBlocked?: (key: string, turn: Task[], category: string | null) => void   // the safety check stopped a turn (core/blocks.ts)
  // A turn ended, or the session closed: the tasks it leaves behind. limit: it ended on the usage limit or an
  // overload, so it did none of them (runtime/limit-pause.ts).
  onTurn?: (key: string, tasks: Task[], limit?: Limit) => void
  // A kagelet lane (core/kagelets.ts): its grant. Only these tools, and it approves nothing.
  grantOf?: (key: string) => string[] | undefined
  // A kagelet lane's tool call, for the event log: the tool's name and why it was refused, never its input.
  onTool?: (key: string, tool: string, refused?: string) => void
  // A kagelet lane: what it may spend before a cap (core/kagelets.ts budgetLeft). The SDK stops the run there.
  budgetOf?: (key: string) => number | undefined
  restartMs?: number
}) {
  const sessions = new Map<string, Session>()
  // A thread's model and effort, asked for in the thread. Kept after its session closes, so the next one starts on it.
  // ponytail: lost on a hub restart, save it in the store if people mind.
  const picks = new Map<string, Pick>()
  // Kage's own tools, approved for every session (hub.ts does the same for panes). Approved in canUseTool, not
  // allowedTools, which would skip the callback and makes the SDK warn on every session.
  const ALLOWED = ['reply', 'edit_message', 'delete_message', 'send_file', 'message_people', 'schedule', 'unschedule', 'schedules', 'set_model', 'kagelets'].map(t => `mcp__kage__${t}`)

  function open(key: string, s: Session, carried: SDKUserMessage[] = []) {
    const inbox = makeInbox(carried)
    const server = o.sdk.createSdkMcpServer({
      name: 'kage', instructions: s.kage.instructions,
      tools: [...s.kage.tools.map(t => o.sdk.tool(t.name, t.description, t.shape, async args => {
        const r = await t.run(args)
        return { isError: r.isError, content: [{ type: 'text' as const, text: r.text }] }
      })), o.sdk.tool('set_model', SET_MODEL, {
        // Aliases only: a typo'd full id would pass setModel and then fail every turn of the thread.
        model: z.enum(['fable', 'opus', 'sonnet', 'haiku', 'default']).optional(),
        effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max', 'default']).optional().describe('reasoning effort; maximum or ultra means max'),
      }, async a => {
        // Only set keys go in the pick: an undefined one would override the hub's own options on reopen.
        const pick: Pick = { ...picks.get(key) }
        if (a.model) {
          await q.setModel(a.model === 'default' ? undefined : a.model)
          if (a.model === 'default') delete pick.model; else pick.model = a.model
          picks.set(key, { ...pick })
        }
        if (a.effort) {
          await q.applyFlagSettings({ effortLevel: a.effort === 'default' ? null : a.effort })
          if (a.effort === 'default') delete pick.effort; else pick.effort = a.effort
          picks.set(key, { ...pick })
        }
        log('set_model', key, s.sender, pick.model ?? 'default', pick.effort ?? 'default')
        return { content: [{ type: 'text' as const, text: `This thread now runs on ${pick.model ?? 'the default model'} at ${pick.effort ?? 'default'} effort.` }] }
      })],
    })
    const { KAGE_THREAD: _, ...env } = process.env   // with it, the kage plugin's own channel would take the thread
    const resumed = o.hasTranscript(s.id)
    const budget = o.budgetOf?.(key)
    const q = o.sdk.query({
      prompt: inbox,
      options: {
        ...o.options,
        ...(resumed ? { resume: s.id } : { sessionId: s.id }),
        ...picks.get(key),
        ...budget !== undefined && { maxBudgetUsd: budget },
        systemPrompt: { type: 'preset', preset: 'claude_code' },
        mcpServers: { ...o.options.mcpServers, kage: server },
        // Its jobs die with the session; the schedule tool replaces it.
        disallowedTools: [...o.options.disallowedTools ?? [], 'CronCreate', 'CronDelete', 'CronList'],
        // Claude Code sends session_state_changed, which busy() reads, only when asked.
        env: { ...env, CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '1' },
        // A kagelet's grant is its approval, checked first: beyond it, even Kage's tools that act as the owner, it
        // approves nothing and puts no card in front of the owner. The PreToolUse hook checks the same grant again.
        canUseTool: (name, input, x) => o.grantOf?.(key)
          ? Promise.resolve(grantRefusal(name, o.grantOf(key)!, input) ? { behavior: 'deny' as const, message: 'A kagelet approves nothing. Say in the thread what you needed and why: your manager decides.' }
            : { behavior: 'allow' as const, updatedInput: input })
          // A grant beyond the web tools raises its own card from inside the tool (runtime/kagelets.ts), so the owner
          // gets one, not two. A revoke only takes access away, so it needs none (the tool still takes it from the
          // owner's task only).
          : ALLOWED.includes(name) || (name === 'mcp__kage__manage_kagelet' && ((input.action === 'save' && Array.isArray(input.tools) && input.tools.some(t => !DEFAULT_GRANT.includes(t))) || input.action === 'revoke')) ? Promise.resolve({ behavior: 'allow' as const, updatedInput: input })
          : ask(key, s, name, x.title ?? x.description ?? '', input, x.signal),
        // The same rules as private-data-guard.ts, in-process. A failed check blocks the call.
        hooks: {
          PreToolUse: [{
            onFailure: 'block',
            hooks: [async input => {
              const i = input as { tool_name: string; tool_input?: Record<string, string> }
              const grant = o.grantOf?.(key)
              const reason = (grant && grantRefusal(i.tool_name, grant, i.tool_input ?? {})) || (privateToolRefusal(i.tool_name, s.sender) ?? voiceToolRefusal(i.tool_name, s.sender) ?? slackSendRefusal(i.tool_name) ?? ownerMemoryRefusal(i.tool_name, i.tool_input ?? {}, o.ownerMemory))
              if (grant) o.onTool?.(key, i.tool_name, reason || undefined)
              return reason ? { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } } : {}
            }],
          }],
        },
      },
    })
    const send = (m: ToSession) => {
      if (m.type === 'verdict') { s.asks.get(m.request_id)?.(m.behavior); return }
      s.sender = senderOf(m)
      s.turn.push({ task: m, mid: s.state !== 'idle' })
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
      let blocked = false   // once per turn: a new CLI sends the system event and the refused assistant frame
      let limit: Limit['kind'] | undefined   // this turn's top-level answer was the usage limit or an overload
      let resetsAt: number | undefined       // the reset time Claude last gave with a rejection
      try {
        for await (const m of q as AsyncIterable<SDKMessage>) {
          s.last = Date.now()
          connect()
          if (m.type === 'system' && m.subtype === 'session_state_changed') { sawState = true; s.state = m.state }
          // A Claude Code that never sends the state event: the turn's result is the best idle signal.
          // The system event carries the category. An older CLI only marks stop_reason on the assistant frame.
          // A subagent's refusal ends only its own answer, not the thread.
          const refused = (m.type === 'system' && m.subtype === 'model_refusal_no_fallback') || (m.type === 'assistant' && !m.parent_tool_use_id && m.message.stop_reason === 'refusal')
          if (refused && !blocked) {
            blocked = true
            o.onBlocked?.(key, s.turn.map(x => x.task), (m.type === 'system' && m.subtype === 'model_refusal_no_fallback' && m.api_refusal_category) || null)
          }
          // Seconds from Claude Code; ms is accepted too.
          if (m.type === 'rate_limit_event' && m.rate_limit_info.status === 'rejected' && m.rate_limit_info.resetsAt) resetsAt = m.rate_limit_info.resetsAt < 1e12 ? m.rate_limit_info.resetsAt * 1000 : m.rate_limit_info.resetsAt
          // The last top-level answer decides: after a limit, Claude Code may try again and get a real one.
          if (m.type === 'assistant' && !m.parent_tool_use_id) limit = m.error === 'rate_limit' || m.error === 'overloaded' ? m.error : undefined
          if (m.type === 'result' && m.is_error && !limit) {
            // An older CLI marks no assistant message: the HTTP status on the result says the same.
            const status = 'api_error_status' in m ? m.api_error_status : undefined
            limit = status === 429 ? 'rate_limit' : status === 529 ? 'overloaded' : undefined
          }
          // Every result reports its cost, a limit's too: the money was spent either way.
          if (m.type === 'result') o.onResult?.(key, m.total_cost_usd, resumed)
          if (m.type === 'result' && limit) {
            // The turn did nothing, and a task sent mid-turn would only hit the limit too: all of them go back.
            const tasks = s.turn.map(x => x.task)
            s.turn = []
            blocked = false
            o.onTurn?.(key, tasks, { kind: limit, ...(limit === 'rate_limit' && resetsAt && { until: resetsAt }) })
            limit = undefined
          } else if (m.type === 'result') {
            // A task sent mid-turn may be read by the next turn instead, so it stays one turn longer.
            blocked = false
            const done = s.turn.filter(x => !x.mid).map(x => x.task)
            s.turn = s.turn.filter(x => x.mid).map(x => ({ ...x, mid: false }))
            if (done.length) o.onTurn?.(key, done)
          }
          if (m.type === 'result' && !sawState) s.state = 'idle'
        }
      } catch (e) { log('session ended', key, e) }
      // The process went away on the limit before it sent a result: its tasks go back the same way.
      if (limit && s.turn.length) o.onTurn?.(key, s.turn.splice(0).map(x => x.task), { kind: limit, ...(limit === 'rate_limit' && resetsAt && { until: resetsAt }) })
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
        id, state: 'idle', last: 0, stopped: false, asks: new Map(), turn: [],
        kage: o.tools(key, m => o.toHub(key, m), (tool, description, input) => ask(key, s, tool, description, input, new AbortController().signal).then(r => r.behavior === 'allow')),
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
      // Closed with tasks in hand: nothing waits for their turn any more.
      if (s.turn.length) o.onTurn?.(key, s.turn.splice(0).map(x => x.task))
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

const SET_MODEL = 'Switch the model or reasoning effort of this thread, when the owner or a teammate asks for it in plain words ("use opus max", "go back to the default"). It applies from the next step and stays for the thread. Leave out what they did not ask to change.'

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
