// The session runtime on the Agent SDK: each thread is one long-lived query() inside the hub, with
// Kage's tools served in-process. It fills the same Runner interface as tmux-panes.ts, so the
// dispatcher does not know which one runs. Unlike a tmux pane, a session here lives and dies with
// the hub process, crons included.
// The SDK comes in as an argument: the hub imports it only when this runtime is on, so a tmux-only install needs none.
import { SLACK_READS, VOICE_READS_LINE, voiceToolOptions } from './slack-read-tools.ts'
import type { createSdkMcpServer, EffortLevel, Options, Query, SDKMessage, SDKUserMessage, tool } from '@anthropic-ai/claude-agent-sdk'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { log, logKey } from './log.ts'
import { makeInbox, type Inbox } from './sdk-inbox.ts'
import { ownerOnlyTool } from '../core/guards.ts'
import { lowestSender, senderOf, withoutInvisible, type Sender } from '../core/gate.ts'
import { certFileEnv, protectConfig, toolRefusal } from './path-guards.ts'
import { grantRefusal, laneOptions, shellGrant } from '../core/kagelets.ts'
import { heldCommand } from '../core/held.ts'
import { approvalPreview } from '../core/preview.ts'
import type { Dispatcher, Runner } from '../core/sessions.ts'
import type { sessionTools } from './kage-tools.ts'
import { eventNeedsCard } from '../core/tripwire.ts'
import type { deferredApprovals } from './deferred-approvals.ts'
import type { Limit } from './limit-pause.ts'
import type { Task } from '../core/task.ts'
import { MODELS } from '../core/config.ts'
import type { ToSession } from './protocol.ts'

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
  sender?: Sender               // the lowest sender in the turn: the guard hook reads it
  turn: { task: Task; mid: boolean; uuid: string; read?: boolean }[]   // tasks the current turn may have read: a safety block reports them. mid: sent mid-turn. read: Claude said it completed
  state: 'idle' | 'running' | 'requires_action'
  last: number
  stopped: boolean
  run?: { q: Query; inbox: Inbox; send: (m: ToSession) => void; started: number }
  asks: Map<string, (b: 'allow' | 'deny') => void>
  ownerTools: boolean; carry: SDKUserMessage[]   // the next process opens with the owner's own tools; what it starts on (#317)
}

export function sdkSessions(o: {
  sdk: Sdk
  hub: () => Dispatcher<ToSession>
  // One set per thread. approve: the owner's card from inside a tool, true only on their yes.
  tools: (key: string, send: (m: { type: 'mail' | 'wa' | 'voice'; text: string }) => void, approve: (tool: string, description: string, input: Record<string, unknown>) => Promise<boolean>, turnSender: () => Sender | undefined) => Kage
  hasTranscript: (id: string) => boolean
  toHub: (key: string, m: { type: 'mail' | 'wa' | 'voice'; text: string }) => void
  options: Options                                 // cwd, settings, settingSources, the claude binary
  ownerMemory: string; sharedTools?: readonly string[]
  codeDir: string; sandbox?: () => boolean          // the hub's code folder (a sandboxed shell may not write there); harness.sandbox, read at each session start
  envFile: string                                 // its folder holds the tokens: only the owner's task touches it
  onStart?: () => void                            // a new id may have been minted: save the map
  // A turn ended: the session's running cost so far. limited: it ended on the usage limit, so it did no work.
  onResult?: (key: string, totalUsd: number, resumed: boolean, limited: boolean) => void
  onBlocked?: (key: string, turn: Task[], category: string | null) => void   // the safety check stopped a turn (core/blocks.ts)
  // A turn ended, or the session closed: the tasks it leaves behind. limit: it ended on the usage limit or an
  // overload, so it did none of them (runtime/limit-pause.ts).
  // done: the turn ended with its result, so it finished these tasks; with no done, they were cut or closed.
  onTurn?: (key: string, tasks: Task[], limit?: Limit, done?: true) => void
  // A kagelet lane (core/kagelets.ts): its grant (only these tools, and it approves nothing) and the owner's allow lines.
  grantOf?: (key: string) => string[] | undefined; allowOf?: (key: string) => string[]; reviewHeld?: (key: string, command: string) => Promise<boolean>
  // A kagelet lane's tool call, for the event log: the tool's name and why it was refused, never its input.
  onTool?: (key: string, tool: string, refused?: string) => void
  // A kagelet lane: what it may spend before a cap (core/kagelets.ts budgetLeft). The SDK stops the run there.
  budgetOf?: (key: string) => number | undefined
  // A kagelet lane: the model its file names (core/kagelets.ts). No set_model reaches a lane, so nothing overrides it.
  modelOf?: (key: string) => string | undefined
  // The SSM relay (runtime/ssm-relay.ts): an owner-only thread's env carries a token, the socket and the stand-in session-manager-plugin first on PATH (cli/ssm-plugin-shim), so its ssh reaches AWS through the hub. issue returns nothing for any other thread.
  ssm?: { sock: string; shim: string; issue: (key: string) => string | undefined; drop: (key: string) => void }
  // Approvals that wait outside the session (#177): a card ends the turn instead of holding it, and the owner's yes
  // starts a new turn that retries the call. Absent: the card holds the session until the owner answers.
  deferred?: ReturnType<typeof deferredApprovals>
  // The key proxy (runtime/key-proxy.ts, #182): same shape and same threads as ssm. Held keys are not in any session's env.
  keys?: { sock: string; issue: (key: string) => string | undefined; drop: (key: string) => void }
  restartMs?: number
}) {
  const sessions = new Map<string, Session>()
  // A thread's model and effort, asked for in the thread. Kept after its session closes, so the next one starts on it.
  // ponytail: lost on a hub restart, save it in the store if people mind.
  const picks = new Map<string, Pick>()
  // Kage's own tools, approved for every session (hub.ts does the same for panes). browser_act raises its own
  // card, showing the control as the page labels it, so it is listed here to keep the owner from a second card. set_setting is the same: a safe key needs no card, a power key raises its own. Approved in canUseTool, not
  // allowedTools, which would skip the callback and makes the SDK warn on every session.
  const ALLOWED = ['reply', 'edit_message', 'delete_message', 'send_file', 'make_canvas', 'edit_canvas', 'message_people', 'schedule', 'unschedule', 'schedules', 'set_model', 'kagelets', 'review_kagelet_memory', 'browser_tabs', 'browser_read', 'browser_screenshot', 'browser_snapshot', 'browser_act', 'set_setting', 'meeting_join'].map(t => `mcp__kage__${t}`)

  function open(key: string, s: Session, carried: SDKUserMessage[] = []) {
    const carries = carried.length > 0   // the inbox takes the array itself, so its length changes
    const inbox = makeInbox(carried)
    const full = s.ownerTools
    const voice = key.startsWith('voice:')
    const server = o.sdk.createSdkMcpServer({
      name: 'kage', instructions: s.kage.instructions + (voice ? VOICE_READS_LINE : ''),
      tools: [...s.kage.tools.filter(t => full || !ownerOnlyTool(`mcp__kage__${t.name}`)).map(t => o.sdk.tool(t.name, t.description, t.shape, async args => {
        const r = await t.run(args)
        return { isError: r.isError, content: [{ type: 'text' as const, text: r.text }] }
      }, voiceToolOptions(voice, t.name))), o.sdk.tool('set_model', SET_MODEL, {
        // Aliases only: a typo'd full id would pass setModel and then fail every turn of the thread.
        model: z.enum([...MODELS, 'default']).optional(),
        effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max', 'default']).optional().describe('reasoning effort; maximum or ultra means max'),
      }, async a => {
        // Only set keys go in the pick: an undefined one would override the hub's own options on reopen.
        const pick: Pick = { ...picks.get(key) }
        if (a.model) {
          await q.setModel(a.model === 'default' ? undefined : a.model)
          if (a.model === 'default') delete pick.model; else pick.model = a.model
        }
        if (a.effort) {
          await q.applyFlagSettings({ effortLevel: a.effort === 'default' ? null : a.effort })
          if (a.effort === 'default') delete pick.effort; else pick.effort = a.effort
        }
        picks.set(key, { ...pick })
        log('set_model', logKey(key), s.sender, pick.model ?? 'default', pick.effort ?? 'default')
        return { content: [{ type: 'text' as const, text: `This thread now runs on ${pick.model ?? 'the default model'} at ${pick.effort ?? 'default'} effort.` }] }
      })],
    })
    const { KAGE_THREAD: _, ...env } = process.env   // with it, the kage plugin's own channel would take the thread. KAGE_SESSION below stays: kage set refuses on it.
    const resumed = o.hasTranscript(s.id)
    const budget = o.budgetOf?.(key)
    const grant = o.grantOf?.(key)
    const walled = protectConfig(o.envFile, o.codeDir, undefined, shellGrant(grant) ? 'kagelet' : o.sandbox?.() === true)   // a kagelet's shell runs on text it read
    const ssmToken = grant ? undefined : o.ssm?.issue(key)   // a kagelet lane never gets one
    const keysToken = grant ? undefined : o.keys?.issue(key)
    const q = o.sdk.query({
      prompt: inbox,
      options: {
        ...o.options,
        settings: { ...(o.options.settings as object), ...walled, ...!full && { disableClaudeAiConnectors: true } },
        ...(resumed ? { resume: s.id } : { sessionId: s.id }),
        ...(o.modelOf?.(key) && { model: o.modelOf(key) }),
        ...picks.get(key),
        ...budget !== undefined && { maxBudgetUsd: budget },
        ...grant && laneOptions(grant),
        systemPrompt: { type: 'preset', preset: 'claude_code' },
        mcpServers: { ...o.options.mcpServers, kage: server },
        disallowedTools: [...o.options.disallowedTools ?? [], 'CronCreate', 'CronDelete', 'CronList'],   // its jobs die with the session: the schedule tool replaces it
        // Claude Code sends session_state_changed, which busy() reads, only when asked.
        env: { ...env, ...certFileEnv(), CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '1', KAGE_SESSION: '1', ...ssmToken && { KAGE_SSM_TOKEN: ssmToken, KAGE_SSM_SOCK: o.ssm!.sock, PATH: `${o.ssm!.shim}:${env.PATH}` }, ...keysToken && { KAGE_KEYS_TOKEN: keysToken, KAGE_KEYS_SOCK: o.keys!.sock } },
        // A kagelet's grant is its approval, checked first: beyond it, even Kage's tools that act as the owner, it
        // approves nothing and puts no card in front of the owner. The PreToolUse hook checks the same grant again.
        canUseTool: (name, input, x) => o.grantOf?.(key)
          ? Promise.resolve(grantRefusal(name, o.grantOf(key)!, input, o.allowOf?.(key)) ? { behavior: 'deny' as const, message: 'A kagelet approves nothing. Say in the thread what you needed and why: your manager decides.' }
            : { behavior: 'allow' as const, updatedInput: input })
          // A save is approved inside the tool by tier (runtime/kagelets.ts): Kage grants read, and a write tool raises
          // its own card, so the owner gets one, not two. A revoke only takes access away, so it needs none (the tool
          // still takes it from the owner's task only).
          : (ALLOWED.includes(name) && !eventNeedsCard(name, input, s.sender)) || SLACK_READS.includes(name) || (name === 'mcp__kage__manage_kagelet' && (input.action === 'save' || input.action === 'revoke')) ? Promise.resolve({ behavior: 'allow' as const, updatedInput: input })
          : s.turn.some(x => senderOf(x.task) === 'agent') ? Promise.resolve({ behavior: 'deny' as const, message: "An agent's task may only read and answer: no card goes to the owner." }) : o.deferred?.take(key, name, input, Date.now()) ? Promise.resolve({ behavior: 'allow' as const, updatedInput: input })
          : o.deferred && s.turn.length ? defer(key, s, name, x.title ?? x.description ?? '', input)
          : ask(key, s, name, x.title ?? x.description ?? '', input, x.signal),
        // The same rules as plugin/private-data-guard.ts, in-process. A failed check blocks the call.
        hooks: {
          PreToolUse: [{
            onFailure: 'block',
            hooks: [async input => {
              const i = input as { tool_name: string; tool_input?: Record<string, string> }
              const grant = o.grantOf?.(key)
              const path = toolRefusal(i.tool_name, i.tool_input ?? {}, s.turn.some(x => senderOf(x.task) === 'agent') ? 'agent' : s.sender, o), held = grant && grantRefusal(i.tool_name, grant, i.tool_input ?? {}, o.allowOf?.(key))
              // An agent's task anywhere in the turn binds it (a mid-turn task joins the turn). Only a grant hold may be let through by the reviewer, never a path guard; allow here, so canUseTool's grant check never sees it.
              const step = !!held && !path && i.tool_name === 'Bash' && shellGrant(grant!), command = { command: String(i.tool_input?.command ?? '') }
              // The owner's yes is spent first, and a step whose card is open stays the owner's, so no step runs twice. Else the reviewer; else a card (the command only, so a reworded retry still matches).
              const taken = step && !!o.deferred?.take(key, 'Bash', command, Date.now()), wait = step && !taken ? o.deferred?.waiting(key, 'Bash', command, Date.now()) : undefined
              const released = taken || step && wait !== 'same' && !!await o.reviewHeld?.(key, command.command), card = step && !released && !wait && o.deferred && s.turn.length ? await defer(key, s, 'Bash', `A kagelet's one-way step: ${heldCommand(command.command)}. Reply \`always\` to run it and let this exact command run with no ask from now on.`, command) : undefined
              const reason = released ? undefined : card?.interrupt || wait === 'same' ? `Held: ${heldCommand(command.command)} is a one-way step. The owner's card is posted, so it is not in your needs. Go on with the rest of the job; when they answer, a new task says so.` : held || path
              if (grant) o.onTool?.(key, i.tool_name, reason || undefined)
              return reason ? { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } } : released ? { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } } : {}
            }],
          }],
        },
      },
    })
    let sawState = false, unseen = false   // unseen: a message went in since Claude last said running, so an idle may predate it
    // Once the owner wrote here, a message that finds this process idle starts a new one with the owner's tools, and goes
    // in first. Claude Code says idle only after it read every message (measured); with no state events, only an empty turn counts.
    const send = (m: ToSession) => {
      if (m.type === 'verdict') { s.asks.get(m.request_id)?.(m.behavior); return }
      const from = senderOf(m), answered = sawState && s.state === 'idle' && !unseen   // idle comes only once Claude read every message
      s.ownerTools ||= from === 'owner'; s.sender = from === 'owner' && !answered ? lowestSender(s.turn.map(x => x.task)) : from   // the owner's mid-turn "thanks" never lifts a teammate's turn
      const reopen = s.ownerTools && !full && s.state === 'idle' && (sawState ? !unseen : !s.turn.length)
      if (reopen && s.turn.length) o.onTurn?.(key, s.turn.splice(0).map(x => x.task), undefined, true)   // idle: it read and answered them
      const uuid = randomUUID(); s.turn.push({ task: m, mid: s.state !== 'idle', uuid })   // the uuid ties Claude Code's command_lifecycle frames to this task
      s.kage.onTask(m)
      s.state = 'running'; s.last = Date.now()
      // Nothing more goes to a closing process: it may take a message and die before it answers.
      if (reopen || s.carry.length) { s.carry.push(userMessage(m, uuid)); q.close() } else { inbox.push(userMessage(m, uuid)); unseen = true }
    }
    s.run = { q, inbox, send, started: Date.now() }
    let connected = false
    // Connected at the handshake, or else its first message. One that never starts leaves its tasks to the dispatcher.
    // Once started, it is busy with what it carries until Claude says idle. One that never starts holds no slot.
    const connect = () => { if (connected || s.stopped) return; connected = o.hub().connect(key, send); if (carries) s.state = 'running' }
    q.initializationResult().then(connect, () => {})
    void (async () => {
      let blocked = false   // once per turn: a new CLI sends the system event and the refused assistant frame
      let limit: Limit['kind'] | undefined   // this turn's top-level answer was the usage limit or an overload
      let resetsAt: number | undefined, window: string | undefined   // the reset time and usage window Claude last gave with a rejection
      try {
        for await (const m of q as AsyncIterable<SDKMessage>) {
          s.last = Date.now()
          connect()
          if (m.type === 'system' && m.subtype === 'session_state_changed') { sawState = true; s.state = m.state; if (m.state === 'running') unseen = false }
          const life = m as { type: string; command_uuid?: string; state?: string }; if (life.type === 'command_lifecycle' && life.state === 'completed') for (const x of s.turn) if (x.uuid === life.command_uuid) x.read = true   // Claude Code finished a message we sent (not in the SDK's types yet); measured: one folded in mid-turn completes before that turn's result
          // A Claude Code that never sends the state event: the turn's result is the best idle signal.
          // The system event carries the category. An older CLI only marks stop_reason on the assistant frame.
          // A subagent's refusal ends only its own answer, not the thread.
          const refused = (m.type === 'system' && m.subtype === 'model_refusal_no_fallback') || (m.type === 'assistant' && !m.parent_tool_use_id && m.message.stop_reason === 'refusal')
          if (refused && !blocked) {
            blocked = true
            o.onBlocked?.(key, s.turn.map(x => x.task), (m.type === 'system' && m.subtype === 'model_refusal_no_fallback' && m.api_refusal_category) || null)
          }
          // Seconds from Claude Code; ms is accepted too.
          if (m.type === 'rate_limit_event' && m.rate_limit_info.status === 'rejected') ({ rateLimitType: window } = m.rate_limit_info, resetsAt = m.rate_limit_info.resetsAt && (m.rate_limit_info.resetsAt < 1e12 ? m.rate_limit_info.resetsAt * 1000 : m.rate_limit_info.resetsAt))
          // The last top-level answer decides: after a limit, Claude Code may try again and get a real one.
          if (m.type === 'assistant' && !m.parent_tool_use_id) limit = m.error === 'rate_limit' || m.error === 'overloaded' ? m.error : undefined
          if (m.type === 'result' && m.is_error && !limit) {
            // An older CLI marks no assistant message: the HTTP status on the result says the same.
            const status = 'api_error_status' in m ? m.api_error_status : undefined
            limit = status === 429 ? 'rate_limit' : status === 529 ? 'overloaded' : undefined
          }
          // Every result reports its cost, a limit's too: the money was spent either way.
          if (m.type === 'result') o.onResult?.(key, m.total_cost_usd, resumed, !!limit)
          if (m.type === 'result' && limit) {
            // The turn did nothing, and a task sent mid-turn would only hit the limit too: all of them go back.
            const tasks = s.turn.map(x => x.task)
            s.turn = []
            blocked = false
            o.onTurn?.(key, tasks, { kind: limit, ...(limit === 'rate_limit' && resetsAt && { until: resetsAt }), ...(limit === 'rate_limit' && window && { window }) })
            limit = window = resetsAt = undefined
          } else if (m.type === 'result') {
            // A task sent mid-turn may be read by the next turn instead, so it stays one turn longer, unless Claude said this turn completed it.
            blocked = false
            const done = s.turn.filter(x => !x.mid || x.read).map(x => x.task)
            s.turn = s.turn.filter(x => x.mid && !x.read).map(x => ({ ...x, mid: false })); if (s.turn.length) s.sender = lowestSender(s.turn.map(x => x.task))
            if (done.length) o.onTurn?.(key, done, undefined, true)
          }
          if (m.type === 'result' && !sawState) s.state = 'idle'
        }
      } catch (e) { log('session ended', logKey(key), e) }
      // The process went away on the limit before it sent a result: its tasks go back the same way.
      if (limit && s.turn.length) o.onTurn?.(key, s.turn.splice(0).map(x => x.task), { kind: limit, ...(limit === 'rate_limit' && resetsAt && { until: resetsAt }), ...(limit === 'rate_limit' && window && { window }) })
      // The Claude process is gone, and its open approvals with it. Unless the dispatcher closed it, it comes back on
      // the same conversation, like the shell loop in a tmux pane, and takes the tasks this process never read.
      denyAll(s)
      s.state = 'idle'
      if (s.stopped) return
      // It exited with no result: a kagelet message's turn did not finish it, so it goes back to wait (runtime/kagelets.ts).
      const lost = s.turn.filter(x => x.task.handoff)
      if (lost.length) { s.turn = s.turn.filter(x => !x.task.handoff); o.onTurn?.(key, lost.map(x => x.task)) }
      o.hub().disconnect(key, send)
      // Nor does the new process take one it never read: the store hands it out again.
      const gone = new Set(lost.map(x => channelTag(x.task)))
      const unread = [...inbox.drain(), ...s.carry.splice(0)].filter(u => !gone.has(u.message.content as string))
      setTimeout(() => { if (!s.stopped) open(key, s, unread) }, s.ownerTools && !full ? 0 : o.restartMs ?? 3000)
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

  // The owner's card without the session waiting: the call is refused with an interrupt, so the turn ends and the
  // slot frees. The owner's yes (hub/router.ts) starts a turn that retries the same call, which passes once.
  async function defer(key: string, s: Session, tool: string, description: string, input: Record<string, unknown>) {
    const store = o.deferred!
    const id = requestId()
    try { await s.kage.askOwner({ id, tool, description, preview: approvalPreview(tool, input) }) } catch (e: any) {
      log('permission prompt failed', e?.data?.error ?? e)
      return { behavior: 'deny' as const, message: 'The owner did not approve this.' }
    }
    store.add({ id, key, tool, input, task: s.turn.at(-1)!.task }, Date.now())
    return { behavior: 'deny' as const, interrupt: true, message: "The owner's card is posted. This turn ends here. When they answer, a new task says so." }
  }

  const denyAll = (s: Session) => { for (const done of [...s.asks.values()]) done('deny') }

  const runner: Runner<ToSession> = {
    start(key, id, first) {
      const s: Session = sessions.get(key) ?? {
        id, state: 'idle', last: 0, stopped: false, asks: new Map(), turn: [], carry: [], ownerTools: key.startsWith('voice:') || (first?.type === 'task' && senderOf(first) === 'owner'),   // a live call never reopens
        kage: o.tools(key, m => o.toHub(key, m), (tool, description, input) => ask(key, s, tool, description, input, new AbortController().signal).then(r => r.behavior === 'allow'), () => s.sender),
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
      o.ssm?.drop(key)
      o.keys?.drop(key)
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
  return { runner, running: () => new Set([...sessions.values()].map(s => s.id)), usage: () => [...sessions.values()].find(s => s.run && !s.stopped)?.run!.q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }) }
}

const SET_MODEL = 'Switch the model or reasoning effort of this thread, when the owner or a teammate asks for it in plain words ("use opus max", "go back to the default"). It applies from the next step and stays for the thread. Leave out what they did not ask to change.'

// A task as Claude Code shows a channel message. Attributes are escaped, and the content cannot
// open or close a channel tag of its own.
const userMessage = (m: Task, uuid: string) => ({ type: 'user', message: { role: 'user', content: channelTag(m) }, parent_tool_use_id: null, uuid }) as SDKUserMessage

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
