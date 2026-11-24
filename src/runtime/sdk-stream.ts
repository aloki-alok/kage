import { threadKind } from '../core/ledgers.ts'
import type { Query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { log, logKey } from './log.ts'
import { channelTag, type Inbox } from './sdk-inbox.ts'
import { lowestSender, OWNER_AGAIN, senderOf } from '../core/gate.ts'
import type { Limit } from './limit-pause.ts'
import type { Task } from '../core/task.ts'
import type { ToSession } from './protocol.ts'
import { denyAll, senderNow } from './sdk-permissions.ts'
import type { Hub, Session } from './sdk-sessions.ts'

export type Live = {
  key: string; s: Session; q: Query; inbox: Inbox; full: boolean; resumed: boolean
  sawState: boolean; unseen: boolean
  send: (m: ToSession) => void; connect: () => void; reopen: (carried: SDKUserMessage[]) => void
}
type Turn = { blocked: boolean; started?: string; limit?: Limit['kind']; resetsAt?: number; window?: string }

export const HOOK_ENDINGS = ['blocked_by_hook', 'stopped_by_hook', 'dropped_by_hook', 'not_passed_on', 'no_verdict']
const ownerAgain = (t: Task): Task => ({ ...t, content: `${OWNER_AGAIN}\n${t.content}` })
const limitNote = (t: Turn): Limit => ({ kind: t.limit!, ...(t.limit === 'rate_limit' && t.resetsAt && { until: t.resetsAt }), ...(t.limit === 'rate_limit' && t.window && { window: t.window }) })

function sendAgain(live: Live) {
  if (live.unseen && live.s.turn.length) return
  live.unseen = false
  for (const t of live.s.again.splice(0)) live.send(ownerAgain(t))
}

export async function follow(h: Hub, live: Live) {
  const t: Turn = { blocked: false }
  try {
    for await (const m of live.q as AsyncIterable<SDKMessage>) {
      live.s.last = Date.now()
      live.connect()
      onState(live, t, m)
      onStop(h, live, t, m)
      onLimit(t, m)
      if (m.type === 'result') onResult(h, live, t, m)
    }
  } catch (e) { log('session ended', logKey(live.key), e) }
  afterEnd(h, live, t)
}

function onState(live: Live, t: Turn, m: SDKMessage) {
  const { s } = live
  if (m.type === 'system' && m.subtype === 'session_state_changed') { live.sawState = true; s.state = m.state; if (m.state === 'running') live.unseen = false; if (m.state === 'idle') sendAgain(live) }
  const life = m as { type: string; command_uuid?: string; state?: string }; if (life.type === 'command_lifecycle' && life.state === 'completed') for (const x of s.turn) if (x.uuid === life.command_uuid) x.read = true
  if (life.type === 'command_lifecycle') t.started = life.state === 'started' ? life.command_uuid : life.command_uuid === t.started ? undefined : t.started
}

function onStop({ o }: Hub, { key, s }: Live, t: Turn, m: SDKMessage) {
  const refused = (m.type === 'system' && m.subtype === 'model_refusal_no_fallback') || (m.type === 'assistant' && !m.parent_tool_use_id && m.message.stop_reason === 'refusal')
  if (refused && !t.blocked) {
    t.blocked = true
    o.onBlocked?.(key, s.turn.map(x => x.task), (m.type === 'system' && m.subtype === 'model_refusal_no_fallback' && m.api_refusal_category) || null)
  }
  const ended = m.type === 'system' && (m as { prompt_submit_outcome?: { kind: string; reason?: string; prompt_kept?: boolean } }).prompt_submit_outcome
  if (ended && HOOK_ENDINGS.includes(ended.kind) && !ended.prompt_kept) {
    const hit = s.turn.filter(x => x.uuid === t.started)
    o.onDropped?.(key, (hit.length ? hit : s.turn).map(x => x.task), ended.reason ?? '', ended.kind)
    t.started = undefined
    if (hit.length) {
      s.turn = s.turn.filter(x => !hit.includes(x))
      if (s.turn.length) s.sender = lowestSender(s.turn.map(x => x.task))
      o.onTurn?.(key, hit.map(x => x.task), undefined, true)
    }
  }
}

function onLimit(t: Turn, m: SDKMessage) {
  if (m.type === 'rate_limit_event' && m.rate_limit_info.status === 'rejected') ({ rateLimitType: t.window } = m.rate_limit_info, t.resetsAt = m.rate_limit_info.resetsAt && (m.rate_limit_info.resetsAt < 1e12 ? m.rate_limit_info.resetsAt * 1000 : m.rate_limit_info.resetsAt))
  if (m.type === 'assistant' && !m.parent_tool_use_id) t.limit = m.error === 'rate_limit' || m.error === 'overloaded' ? m.error : undefined
  if (m.type === 'result' && m.is_error && !t.limit) {
    const status = 'api_error_status' in m ? m.api_error_status : undefined
    t.limit = status === 429 ? 'rate_limit' : status === 529 ? 'overloaded' : undefined
  }
}

function turnModel({ spent }: Hub, live: Live, used: Record<string, { costUSD: number }> | undefined) {
  if (!used) return {}
  const before = spent.get(live.s.id), now = Object.fromEntries(Object.entries(used).map(([m, u]) => [m, u.costUSD]))
  spent.set(live.s.id, now)
  if (!before && live.resumed) return {}
  const [top] = Object.entries(now).map(([m, usd]) => [m, usd - (before?.[m] ?? 0)] as const).filter(([, grew]) => grew > 0).sort((a, b) => b[1] - a[1])
  return top ? { model: top[0] } : {}
}

function onResult(h: Hub, live: Live, t: Turn, m: Extract<SDKMessage, { type: 'result' }>) {
  const { key, s } = live, { o } = h
  o.onResult?.(key, m.total_cost_usd, live.resumed, !!t.limit, m.is_error ? m.subtype : undefined, m.usage && { input: m.usage.input_tokens, cacheWrite: m.usage.cache_creation_input_tokens ?? 0, cacheRead: m.usage.cache_read_input_tokens ?? 0, output: m.usage.output_tokens, who: threadKind(key, senderNow(o, s)), ...turnModel(h, live, m.modelUsage) })
  if (t.limit) {
    const tasks = s.turn.map(x => x.task)
    s.turn = []
    t.blocked = false
    o.onTurn?.(key, tasks, limitNote(t))
    t.limit = t.window = t.resetsAt = undefined
  } else {
    t.blocked = false
    const again = s.sender === 'owner' ? [] : s.turn.filter(x => (!x.mid || x.read) && senderOf(x.task) === 'owner').map(x => x.task)
    s.again.push(...again)
    const done = s.turn.filter(x => (!x.mid || x.read) && !again.includes(x.task)).map(x => x.task)
    s.turn = s.turn.filter(x => x.mid && !x.read).map(x => ({ ...x, mid: false })); if (s.turn.length) s.sender = lowestSender(s.turn.map(x => x.task))
    if (done.length) o.onTurn?.(key, done, undefined, true)
  }
  if (!live.sawState) { s.state = 'idle'; sendAgain(live) }
}

function afterEnd({ o }: Hub, live: Live, t: Turn) {
  const { key, s } = live
  if (t.limit && s.turn.length) o.onTurn?.(key, s.turn.splice(0).map(x => x.task), limitNote(t))
  denyAll(s)
  s.state = 'idle'
  if (s.stopped) return
  const lost = s.turn.filter(x => x.task.handoff)
  if (lost.length) { s.turn = s.turn.filter(x => !x.task.handoff); o.onTurn?.(key, lost.map(x => x.task)) }
  o.hub().disconnect(key, live.send)
  const gone = new Set(lost.map(x => channelTag(x.task)))
  const unread = [...live.inbox.drain(), ...s.carry.splice(0)].filter(u => !gone.has(u.message.content as string))
  setTimeout(() => { if (s.stopped) return; live.reopen(unread); if (s.turn.every(x => senderOf(x.task) === 'owner')) for (const a of s.again.splice(0)) s.run!.send(ownerAgain(a)) }, s.ownerTools && !live.full ? 0 : o.restartMs ?? 3000)
}
