import type { Tokens } from '../core/ledgers.ts'
import { VOICE_READS_LINE, voiceToolOptions } from './slack-read-tools.ts'
import type { createSdkMcpServer, EffortLevel, Options, Query, SDKUserMessage, tool } from '@anthropic-ai/claude-agent-sdk'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { log, logKey } from './log.ts'
import { makeInbox, userMessage, type Inbox } from './sdk-inbox.ts'
import { ownerOnlyTool } from '../core/guards.ts'
import { lowest, lowestSender, OWNER_MID_TURN, senderOf, type Sender } from '../core/gate.ts'
import { certFileEnv, protectConfig } from './path-guards.ts'
import { grantServers, laneOptions, shellGrant } from '../core/kagelets/kagelet.ts'
import { ask, canUse, denyAll, preToolUse } from './sdk-permissions.ts'
import { follow, type Live } from './sdk-stream.ts'
import type { Dispatcher, Runner } from '../core/sessions.ts'
import type { sessionTools } from './kage-tools.ts'
import type { deferredApprovals } from './deferred-approvals.ts'
import type { Review } from './kagelets/review.ts'
import type { Limit } from './limit-pause.ts'
import type { Task } from '../core/task.ts'
import { MODELS } from '../core/config.ts'
import type { ChannelReply, ToSession } from './protocol.ts'

type Kage = ReturnType<typeof sessionTools>
export type Sdk = {
  query: (p: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => Query
  createSdkMcpServer: typeof createSdkMcpServer
  tool: typeof tool
}
type Pick = { model?: string; effort?: EffortLevel }
export type Lean = { model?: string; effort?: string; mcp: Record<string, unknown>; permissions?: Record<string, unknown> }
export type Session = {
  id: string
  kage: Kage
  sender?: Sender
  turn: { task: Task; mid: boolean; uuid: string; read?: boolean }[]
  state: 'idle' | 'running' | 'requires_action'
  last: number
  stopped: boolean
  run?: { q: Query; inbox: Inbox; send: (m: ToSession) => void; started: number }
  asks: Map<string, (b: 'allow' | 'deny') => void>
  ownerTools: boolean; ownerThread: boolean; connectors?: true; carry: SDKUserMessage[]; again: Task[]; held: Task[]
}

export type SdkOptions = {
  sdk: Sdk
  hub: () => Dispatcher<ToSession>
  tools: (key: string, send: (m: ChannelReply) => void, approve: (tool: string, description: string, input: Record<string, unknown>) => Promise<boolean>, turnSender: () => Sender | undefined) => Kage
  hasTranscript: (id: string) => boolean
  trustedNow?: (person: string) => boolean
  toHub: (key: string, m: ChannelReply) => void
  options: Options
  ownerMemory: string; ownMemory?: string; sharedTools?: readonly string[]
  codeDir: string; readRoutes?: () => string[]; sandbox?: (ownerThread: boolean) => boolean; commandOutput?: () => number | undefined
  envFile: string
  onStart?: () => void; onMcp?: (q: Query) => void
  onResult?: (key: string, totalUsd: number, resumed: boolean, limited: boolean, error?: string, tokens?: Tokens) => void
  onBlocked?: (key: string, turn: Task[], category: string | null) => void
  onDropped?: (key: string, turn: Task[], reason: string, kind: string) => void
  onTurn?: (key: string, tasks: Task[], limit?: Limit, done?: true) => void
  grantOf?: (key: string) => string[] | undefined; allowOf?: (key: string) => string[]; reviewHeld?: (key: string, command: string) => Promise<Review>
  onTool?: (key: string, tool: string, refused?: string) => void
  budgetOf?: (key: string) => number | undefined
  modelOf?: (key: string) => string | undefined
  ssm?: { sock: string; shim: string; issue: (key: string) => string | undefined; drop: (key: string) => void }
  deferred?: ReturnType<typeof deferredApprovals>
  keys?: { sock: string; issue: (key: string) => string | undefined; drop: (key: string) => void }
  restartMs?: number
  lean?: () => Lean | undefined
}
export type Hub = { o: SdkOptions; sessions: Map<string, Session>; picks: Map<string, Pick>; spent: Map<string, Record<string, number>> }

function kageServer({ o, picks }: Hub, key: string, s: Session, full: boolean, voice: boolean, q: () => Query) {
  return o.sdk.createSdkMcpServer({
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
        await q().setModel(a.model === 'default' ? undefined : a.model)
        if (a.model === 'default') delete pick.model; else pick.model = a.model
      }
      if (a.effort) {
        await q().applyFlagSettings({ effortLevel: a.effort === 'default' ? null : a.effort })
        if (a.effort === 'default') delete pick.effort; else pick.effort = a.effort
      }
      picks.set(key, { ...pick })
      log('set_model', logKey(key), s.sender, pick.model ?? 'default', pick.effort ?? 'default')
      return { content: [{ type: 'text' as const, text: `This thread now runs on ${pick.model ?? 'the default model'} at ${pick.effort ?? 'default'} effort.` }] }
    })],
  })
}

function queryOptions(h: Hub, key: string, s: Session, full: boolean, resumed: boolean, server: ReturnType<Sdk['createSdkMcpServer']>): Options {
  const { o, picks } = h
  const { KAGE_THREAD: _, ...env } = process.env
  const outputChars = String(o.commandOutput?.() ?? 3000)
  const longOutput = outputChars !== '0' && !env.CLAUDE_CODE_SHELL_PREFIX && { CLAUDE_CODE_SHELL_PREFIX: `${o.codeDir}/src/runtime/long-output.sh`, KAGE_OUTPUT_CHARS: outputChars }
  const budget = o.budgetOf?.(key)
  const grant = o.grantOf?.(key)
  const owners = !full && !s.connectors ? o.lean?.() : undefined
  const walled = protectConfig(o.envFile, o.codeDir, undefined, shellGrant(grant) ? 'kagelet' : o.sandbox?.(s.ownerThread) === true, o.readRoutes?.())
  const ssmToken = grant ? undefined : o.ssm?.issue(key)
  const keysToken = grant ? undefined : o.keys?.issue(key)
  return {
    ...o.options,
    ...owners && { settingSources: (o.options.settingSources ?? []).filter(x => x !== 'user'), ...owners.model && { model: owners.model }, ...owners.effort && { effort: owners.effort as EffortLevel } },
    settings: { ...(o.options.settings as object), ...walled, ...owners?.permissions && !grant && { permissions: { ...owners.permissions, deny: [...Array.isArray(owners.permissions.deny) ? owners.permissions.deny : [], ...walled.permissions.deny] } }, ...!full && !s.connectors && { disableClaudeAiConnectors: true } },
    ...(resumed ? { resume: s.id } : { sessionId: s.id }),
    ...(o.modelOf?.(key) && { model: o.modelOf(key) }),
    ...picks.get(key),
    ...budget !== undefined && { maxBudgetUsd: budget },
    ...grant && laneOptions(grant),
    systemPrompt: { type: 'preset', preset: 'claude_code' },
    mcpServers: { ...o.options.mcpServers, ...owners && grantServers(owners.mcp, grant), kage: server },
    disallowedTools: [...o.options.disallowedTools ?? [], 'CronCreate', 'CronDelete', 'CronList'],
    env: { ...env, ...certFileEnv(), ...longOutput, CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '1', KAGE_SESSION: '1', ...ssmToken && { KAGE_SSM_TOKEN: ssmToken, KAGE_SSM_SOCK: o.ssm!.sock, PATH: `${o.ssm!.shim}:${env.PATH}` }, ...keysToken && { KAGE_KEYS_TOKEN: keysToken, KAGE_KEYS_SOCK: o.keys!.sock } },
    canUseTool: canUse(h, key, s),
    hooks: { PreToolUse: [{ onFailure: 'block', hooks: [preToolUse(h, key, s)] }] },
  }
}

function sendTo({ o }: Hub, live: Live) {
  return (m: ToSession) => {
    const { key, s, full } = live
    if (m.type === 'verdict') { s.asks.get(m.request_id)?.(m.behavior); return }
    const from = senderOf(m), answered = live.sawState && s.state === 'idle' && !live.unseen
    if (from === 'owner' && !full && live.sawState && s.state !== 'idle' && !s.turn.length) { s.ownerTools = s.ownerThread = true; s.held.push(m); return }
    s.ownerTools ||= from === 'owner'; s.ownerThread ||= from === 'owner'; s.sender = answered || !s.turn.length ? from : lowest([lowestSender(s.turn.map(x => x.task)), from])
    const shown = from === 'owner' && s.sender !== 'owner' ? { ...m, content: `${OWNER_MID_TURN}\n${m.content}` } : m
    const reopen = s.ownerTools && !full && s.state === 'idle' && (live.sawState ? !live.unseen : !s.turn.length)
    if (reopen && s.turn.length) o.onTurn?.(key, s.turn.splice(0).map(x => x.task), undefined, true)
    const uuid = randomUUID(); s.turn.push({ task: m, mid: s.state !== 'idle', uuid })
    s.kage.onTask(m)
    s.state = 'running'; s.last = Date.now()
    if (reopen || s.carry.length) { s.carry.push(userMessage(shown, uuid)); live.q.close() } else { live.inbox.push(userMessage(shown, uuid)); live.unseen = true }
  }
}

function open(h: Hub, key: string, s: Session, carried: SDKUserMessage[] = []) {
  const { o } = h
  const carries = carried.length > 0
  const inbox = makeInbox(carried)
  const full = s.ownerTools
  const resumed = o.hasTranscript(s.id)
  const grant = o.grantOf?.(key)
  let q: Query
  const server = kageServer(h, key, s, full, key.startsWith('voice:'), () => q)
  q = o.sdk.query({ prompt: inbox, options: queryOptions(h, key, s, full, resumed, server) })
  let connected = false
  const live: Live = {
    key, s, q, inbox, full, resumed, sawState: false, unseen: false, send: () => {},
    connect: () => { if (connected || s.stopped) return; connected = o.hub().connect(key, live.send); if (carries) s.state = 'running' },
    reopen: unread => open(h, key, s, unread),
  }
  live.send = sendTo(h, live)
  s.run = { q, inbox, send: live.send, started: Date.now() }
  q.initializationResult().then(() => { live.connect(); if (full && !grant) o.onMcp?.(q) }, () => {})
  void follow(h, live)
}

export function sdkSessions(o: SdkOptions) {
  const sessions = new Map<string, Session>()
  const h: Hub = { o, sessions, picks: new Map(), spent: new Map() }
  const runner: Runner<ToSession> = {
    start(key, id, first) {
      const s: Session = sessions.get(key) ?? {
        id, state: 'idle', last: 0, stopped: false, asks: new Map(), turn: [], carry: [], again: [], held: [], ownerTools: key.startsWith('voice:') || (first?.type === 'task' && senderOf(first) === 'owner'), ownerThread: first?.type === 'task' && senderOf(first) === 'owner', ...first?.type === 'task' && senderOf(first) === 'trusted' && { connectors: true as const },
        kage: o.tools(key, m => o.toHub(key, m), (tool, description, input) => ask(h, key, s, tool, description, input, new AbortController().signal).then(r => r.behavior === 'allow'), () => s.sender),
      }
      Object.assign(s, { id, stopped: false })
      try { open(h, key, s) } catch (e) { sessions.delete(key); throw e }
      sessions.set(key, s)
      o.onStart?.()
    },
    stop(key) {
      const s = sessions.get(key)
      if (!s) return
      s.stopped = true
      const open = [...s.turn.splice(0).map(x => x.task), ...s.held.splice(0)]
      if (open.length) o.onTurn?.(key, open)
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


const SET_MODEL = 'Switch the model or reasoning effort of this thread, when the owner or a teammate asks for it in plain words ("use opus max", "go back to the default"). It applies from the next step and stays for the thread. Leave out what they did not ask to change.'
