import { SLACK_READS, VOICE_READS_LINE, voiceToolOptions } from './slack-read-tools.ts'
import type { createSdkMcpServer, EffortLevel, Options, Query, SDKMessage, SDKUserMessage, tool } from '@anthropic-ai/claude-agent-sdk'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { log, logKey } from './log.ts'
import { channelTag, makeInbox, userMessage, type Inbox } from './sdk-inbox.ts'
import { ownerOnlyTool } from '../core/guards.ts'
import { lowestSender, OWNER_AGAIN, OWNER_MID_TURN, senderOf, type Sender } from '../core/gate.ts'
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
  sender?: Sender
  turn: { task: Task; mid: boolean; uuid: string; read?: boolean }[]
  state: 'idle' | 'running' | 'requires_action'
  last: number
  stopped: boolean
  run?: { q: Query; inbox: Inbox; send: (m: ToSession) => void; started: number }
  asks: Map<string, (b: 'allow' | 'deny') => void>
  ownerTools: boolean; carry: SDKUserMessage[]; again: Task[]
}

export function sdkSessions(o: {
  sdk: Sdk
  hub: () => Dispatcher<ToSession>
  tools: (key: string, send: (m: { type: 'mail' | 'wa' | 'voice'; text: string }) => void, approve: (tool: string, description: string, input: Record<string, unknown>) => Promise<boolean>, turnSender: () => Sender | undefined) => Kage
  hasTranscript: (id: string) => boolean
  toHub: (key: string, m: { type: 'mail' | 'wa' | 'voice'; text: string }) => void
  options: Options
  ownerMemory: string; sharedTools?: readonly string[]
  codeDir: string; sandbox?: () => boolean
  envFile: string
  onStart?: () => void
  onResult?: (key: string, totalUsd: number, resumed: boolean, limited: boolean) => void
  onBlocked?: (key: string, turn: Task[], category: string | null) => void
  onDropped?: (key: string, turn: Task[], reason: string, kind: string) => void
  onTurn?: (key: string, tasks: Task[], limit?: Limit, done?: true) => void
  grantOf?: (key: string) => string[] | undefined; allowOf?: (key: string) => string[]; reviewHeld?: (key: string, command: string) => Promise<boolean>
  onTool?: (key: string, tool: string, refused?: string) => void
  budgetOf?: (key: string) => number | undefined
  modelOf?: (key: string) => string | undefined
  ssm?: { sock: string; shim: string; issue: (key: string) => string | undefined; drop: (key: string) => void }
  deferred?: ReturnType<typeof deferredApprovals>
  keys?: { sock: string; issue: (key: string) => string | undefined; drop: (key: string) => void }
  restartMs?: number
}) {
  const sessions = new Map<string, Session>()
  const picks = new Map<string, Pick>()
  const ALLOWED = ['reply', 'edit_message', 'delete_message', 'send_file', 'make_canvas', 'edit_canvas', 'message_people', 'schedule', 'unschedule', 'schedules', 'set_model', 'kagelets', 'review_kagelet_memory', 'browser_tabs', 'browser_read', 'browser_screenshot', 'browser_snapshot', 'browser_act', 'set_setting', 'meeting_join'].map(t => `mcp__kage__${t}`)

  function open(key: string, s: Session, carried: SDKUserMessage[] = []) {
    const carries = carried.length > 0
    const inbox = makeInbox(carried)
    const full = s.ownerTools
    const voice = key.startsWith('voice:')
    const server = o.sdk.createSdkMcpServer({
      name: 'kage', instructions: s.kage.instructions + (voice ? VOICE_READS_LINE : ''),
      tools: [...s.kage.tools.filter(t => full || !ownerOnlyTool(`mcp__kage__${t.name}`)).map(t => o.sdk.tool(t.name, t.description, t.shape, async args => {
        const r = await t.run(args)
        return { isError: r.isError, content: [{ type: 'text' as const, text: r.text }] }
      }, voiceToolOptions(voice, t.name))), o.sdk.tool('set_model', SET_MODEL, {
        model: z.enum([...MODELS, 'default']).optional(),
        effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max', 'default']).optional().describe('reasoning effort; maximum or ultra means max'),
      }, async a => {
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
    const { KAGE_THREAD: _, ...env } = process.env
    const resumed = o.hasTranscript(s.id)
    const budget = o.budgetOf?.(key)
    const grant = o.grantOf?.(key)
    const walled = protectConfig(o.envFile, o.codeDir, undefined, shellGrant(grant) ? 'kagelet' : o.sandbox?.() === true)
    const ssmToken = grant ? undefined : o.ssm?.issue(key)
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
        disallowedTools: [...o.options.disallowedTools ?? [], 'CronCreate', 'CronDelete', 'CronList'],
        env: { ...env, ...certFileEnv(), CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '1', KAGE_SESSION: '1', ...ssmToken && { KAGE_SSM_TOKEN: ssmToken, KAGE_SSM_SOCK: o.ssm!.sock, PATH: `${o.ssm!.shim}:${env.PATH}` }, ...keysToken && { KAGE_KEYS_TOKEN: keysToken, KAGE_KEYS_SOCK: o.keys!.sock } },
        canUseTool: (name, input, x) => o.grantOf?.(key)
          ? Promise.resolve(grantRefusal(name, o.grantOf(key)!, input, o.allowOf?.(key)) ? { behavior: 'deny' as const, message: 'A kagelet approves nothing. Say in the thread what you needed and why: your manager decides.' }
            : { behavior: 'allow' as const, updatedInput: input })
          : (ALLOWED.includes(name) && !eventNeedsCard(name, input, s.sender)) || SLACK_READS.includes(name) || (name === 'mcp__kage__manage_kagelet' && (input.action === 'save' || input.action === 'revoke')) ? Promise.resolve({ behavior: 'allow' as const, updatedInput: input })
          : s.turn.some(x => senderOf(x.task) === 'agent') ? Promise.resolve({ behavior: 'deny' as const, message: "An agent's task may only read and answer: no card goes to the owner." }) : o.deferred?.take(key, name, input, Date.now()) ? Promise.resolve({ behavior: 'allow' as const, updatedInput: input })
          : o.deferred && s.turn.length ? defer(key, s, name, x.title ?? x.description ?? '', input)
          : ask(key, s, name, x.title ?? x.description ?? '', input, x.signal),
        hooks: {
          PreToolUse: [{
            onFailure: 'block',
            hooks: [async input => {
              const i = input as { tool_name: string; tool_input?: Record<string, string> }
              const grant = o.grantOf?.(key)
              const path = toolRefusal(i.tool_name, i.tool_input ?? {}, s.turn.some(x => senderOf(x.task) === 'agent') ? 'agent' : s.sender, o), held = grant && grantRefusal(i.tool_name, grant, i.tool_input ?? {}, o.allowOf?.(key))
              const step = !!held && !path && i.tool_name === 'Bash' && shellGrant(grant!), command = { command: String(i.tool_input?.command ?? '') }
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
    let sawState = false, unseen = false
    const send = (m: ToSession) => {
      if (m.type === 'verdict') { s.asks.get(m.request_id)?.(m.behavior); return }
      const from = senderOf(m), answered = sawState && s.state === 'idle' && !unseen
      s.ownerTools ||= from === 'owner'; s.sender = from === 'owner' && !answered ? lowestSender(s.turn.map(x => x.task)) : from
      const shown = from === 'owner' && s.sender !== 'owner' ? { ...m, content: `${OWNER_MID_TURN}\n${m.content}` } : m
      const reopen = s.ownerTools && !full && s.state === 'idle' && (sawState ? !unseen : !s.turn.length)
      if (reopen && s.turn.length) o.onTurn?.(key, s.turn.splice(0).map(x => x.task), undefined, true)
      const uuid = randomUUID(); s.turn.push({ task: m, mid: s.state !== 'idle', uuid })
      s.kage.onTask(m)
      s.state = 'running'; s.last = Date.now()
      if (reopen || s.carry.length) { s.carry.push(userMessage(shown, uuid)); q.close() } else { inbox.push(userMessage(shown, uuid)); unseen = true }
    }
    const sendAgain = () => { if (unseen && s.turn.length) return; unseen = false; for (const t of s.again.splice(0)) send(ownerAgain(t)) }
    s.run = { q, inbox, send, started: Date.now() }
    let connected = false
    const connect = () => { if (connected || s.stopped) return; connected = o.hub().connect(key, send); if (carries) s.state = 'running' }
    q.initializationResult().then(connect, () => {})
    void (async () => {
      let blocked = false
      let started: string | undefined
      let limit: Limit['kind'] | undefined
      let resetsAt: number | undefined, window: string | undefined
      try {
        for await (const m of q as AsyncIterable<SDKMessage>) {
          s.last = Date.now()
          connect()
          if (m.type === 'system' && m.subtype === 'session_state_changed') { sawState = true; s.state = m.state; if (m.state === 'running') unseen = false; if (m.state === 'idle') sendAgain() }
          const life = m as { type: string; command_uuid?: string; state?: string }; if (life.type === 'command_lifecycle' && life.state === 'completed') for (const x of s.turn) if (x.uuid === life.command_uuid) x.read = true
          if (life.type === 'command_lifecycle') started = life.state === 'started' ? life.command_uuid : life.command_uuid === started ? undefined : started
          const refused = (m.type === 'system' && m.subtype === 'model_refusal_no_fallback') || (m.type === 'assistant' && !m.parent_tool_use_id && m.message.stop_reason === 'refusal')
          if (refused && !blocked) {
            blocked = true
            o.onBlocked?.(key, s.turn.map(x => x.task), (m.type === 'system' && m.subtype === 'model_refusal_no_fallback' && m.api_refusal_category) || null)
          }
          const ended = m.type === 'system' && (m as { prompt_submit_outcome?: { kind: string; reason?: string; prompt_kept?: boolean } }).prompt_submit_outcome
          if (ended && HOOK_ENDINGS.includes(ended.kind) && !ended.prompt_kept) {
            const hit = s.turn.filter(x => x.uuid === started)
            o.onDropped?.(key, (hit.length ? hit : s.turn).map(x => x.task), ended.reason ?? '', ended.kind)
            started = undefined
            if (hit.length) {
              s.turn = s.turn.filter(x => !hit.includes(x))
              if (s.turn.length) s.sender = lowestSender(s.turn.map(x => x.task))
              o.onTurn?.(key, hit.map(x => x.task), undefined, true)
            }
          }
          if (m.type === 'rate_limit_event' && m.rate_limit_info.status === 'rejected') ({ rateLimitType: window } = m.rate_limit_info, resetsAt = m.rate_limit_info.resetsAt && (m.rate_limit_info.resetsAt < 1e12 ? m.rate_limit_info.resetsAt * 1000 : m.rate_limit_info.resetsAt))
          if (m.type === 'assistant' && !m.parent_tool_use_id) limit = m.error === 'rate_limit' || m.error === 'overloaded' ? m.error : undefined
          if (m.type === 'result' && m.is_error && !limit) {
            const status = 'api_error_status' in m ? m.api_error_status : undefined
            limit = status === 429 ? 'rate_limit' : status === 529 ? 'overloaded' : undefined
          }
          if (m.type === 'result') o.onResult?.(key, m.total_cost_usd, resumed, !!limit)
          if (m.type === 'result' && limit) {
            const tasks = s.turn.map(x => x.task)
            s.turn = []
            blocked = false
            o.onTurn?.(key, tasks, { kind: limit, ...(limit === 'rate_limit' && resetsAt && { until: resetsAt }), ...(limit === 'rate_limit' && window && { window }) })
            limit = window = resetsAt = undefined
          } else if (m.type === 'result') {
            blocked = false
            const again = s.sender === 'owner' ? [] : s.turn.filter(x => (!x.mid || x.read) && senderOf(x.task) === 'owner').map(x => x.task)
            s.again.push(...again)
            const done = s.turn.filter(x => (!x.mid || x.read) && !again.includes(x.task)).map(x => x.task)
            s.turn = s.turn.filter(x => x.mid && !x.read).map(x => ({ ...x, mid: false })); if (s.turn.length) s.sender = lowestSender(s.turn.map(x => x.task))
            if (done.length) o.onTurn?.(key, done, undefined, true)
          }
          if (m.type === 'result' && !sawState) { s.state = 'idle'; sendAgain() }
        }
      } catch (e) { log('session ended', logKey(key), e) }
      if (limit && s.turn.length) o.onTurn?.(key, s.turn.splice(0).map(x => x.task), { kind: limit, ...(limit === 'rate_limit' && resetsAt && { until: resetsAt }), ...(limit === 'rate_limit' && window && { window }) })
      denyAll(s)
      s.state = 'idle'
      if (s.stopped) return
      const lost = s.turn.filter(x => x.task.handoff)
      if (lost.length) { s.turn = s.turn.filter(x => !x.task.handoff); o.onTurn?.(key, lost.map(x => x.task)) }
      o.hub().disconnect(key, send)
      const gone = new Set(lost.map(x => channelTag(x.task)))
      const unread = [...inbox.drain(), ...s.carry.splice(0)].filter(u => !gone.has(u.message.content as string))
      setTimeout(() => { if (s.stopped) return; open(key, s, unread); if (s.turn.every(x => senderOf(x.task) === 'owner')) for (const t of s.again.splice(0)) s.run!.send(ownerAgain(t)) }, s.ownerTools && !full ? 0 : o.restartMs ?? 3000)
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
      s.kage.askOwner({ id, tool, description, preview: approvalPreview(tool, input) }).then(
        () => { if (s.asks.has(id)) o.hub().permission(key, id) },
        e => { log('permission prompt failed', e?.data?.error ?? e); done('deny') },
      )
    })
  }

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
        id, state: 'idle', last: 0, stopped: false, asks: new Map(), turn: [], carry: [], again: [], ownerTools: key.startsWith('voice:') || (first?.type === 'task' && senderOf(first) === 'owner'),
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
      if (s.turn.length) o.onTurn?.(key, s.turn.splice(0).map(x => x.task))
      denyAll(s)
      o.ssm?.drop(key)
      o.keys?.drop(key)
      s.run?.inbox.close()
      s.run?.q.close()
      sessions.delete(key)
    },
    lastActivity: key => sessions.get(key)?.last ?? 0,
    busy(key) {
      const s = sessions.get(key)
      if (!s) return false
      return s.state !== 'idle'
    },
  }
  return { runner, running: () => new Set([...sessions.values()].map(s => s.id)), usage: () => [...sessions.values()].find(s => s.run && !s.stopped)?.run!.q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }) }
}

export const HOOK_ENDINGS = ['blocked_by_hook', 'stopped_by_hook', 'dropped_by_hook', 'not_passed_on', 'no_verdict']
const ownerAgain = (t: Task): Task => ({ ...t, content: `${OWNER_AGAIN}\n${t.content}` })

const SET_MODEL = 'Switch the model or reasoning effort of this thread, when the owner or a teammate asks for it in plain words ("use opus max", "go back to the default"). It applies from the next step and stays for the thread. Leave out what they did not ask to change.'

function requestId() {
  const abc = 'abcdefghijkmnopqrstuvwxyz'
  return Array.from({ length: 5 }, () => abc[Math.floor(Math.random() * abc.length)]).join('')
}
