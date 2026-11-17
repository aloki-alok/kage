// What the owner asks of the hub from their own terminal or DM: the status line, kage tell (their words into a thread),
// and kage relay (which threads may use the SSM relay). Each answers with what it did or why it refused.
import { log } from '../runtime/log.ts'
import { limitLine, pauseLine } from '../core/board.ts'
import { openWaiting } from '../core/ledgers.ts'
import type { Conversation } from '../core/conversations.ts'
import type { Dispatcher } from '../core/sessions.ts'
import { ssmEligible } from '../core/ssm.ts'
import type { Task } from '../core/task.ts'
import type { Ledgers } from '../runtime/ledger.ts'
import type { limitPause } from '../runtime/limit-pause.ts'
import type { ToSession } from '../runtime/protocol.ts'
import type { Store } from '../runtime/store.ts'

export function ownerCommands(o: {
  d: Dispatcher<ToSession>; store: Store; ledgers: Ledgers; limits: ReturnType<typeof limitPause>; MAX: number
  placeOf: (key: string) => string; closedTo: (key: string, task: Task) => void; noteTrust: (key: string, task: Task) => void
  failed: (m: ToSession) => void; dropRelay: (key: string) => void   // cut a thread's live relay and key-proxy tokens
  botDm: string; post: (text: string, at?: { channel: string; thread_ts: string; kind: Conversation['kind'] }) => Promise<{ channel: string; ts: string }>
}) {
  const { d, store, ledgers, limits, MAX, placeOf, closedTo, noteTrust, failed } = o
  function status(): string {
    const s = d.status(Date.now())
    const min = (ms: number) => `${Math.round(ms / 60_000)} min`
    const lines = s.live.map(l => `• ${placeOf(l.key)}: ${l.state}${l.state === 'quiet' ? ` for ${min(l.quietMs)}` : ''}`)
    const open = openWaiting(ledgers.text('waiting')).length
    const paused = limits.paused()
    return [
      ...(paused ? [`*${pauseLine(paused)}*`] : []),
      ...[limitLine(limits.counts)].filter((l): l is string => !!l),
      `*${s.live.length} of ${MAX} sessions*${s.waiting.length ? `, ${s.waiting.length} waiting for a slot` : ''}`,
      ...lines,
      ...s.waiting.map(k => `• ${placeOf(k)}: waiting for a slot`),
      ...s.held.map(k => `• ${placeOf(k)}: open in your terminal (kage attach), tasks wait`),
      `${open} question${open === 1 ? '' : 's'} waiting on you`,
    ].join('\n')
  }
  // kage tell: the owner's words into a thread, typed on this machine. Same shape as a scheduled run (runtime/scheduler.ts).
  function tell(key: string, text: string): { ok: true; held?: true } | { refused: string } {
    const c = store.conversation(key)
    if (!c) return { refused: 'no thread with that key' }
    // ponytail: Slack only, like schedules; email and WhatsApp tasks need their connector's own meta, add when wanted.
    if (c.conversation.connector !== 'slack') return { refused: 'tell works on Slack threads only for now' }
    // Typed words have no inbox message to replay, so they are refused instead of lost.
    const paused = limits.paused()
    if (paused) return { refused: `${paused.draining ? 'Kage is stopping for a restart or a stop' : 'Kage is paused by the usage limit'}, so it would be lost. ${pauseLine(paused)} Tell it again after that` }
    const task: Task = {
      type: 'task', fromOwner: true, content: `From the owner, typed in the terminal: ${text}`,
      meta: { channel: c.conversation.chat, thread_ts: c.conversation.thread ?? '', place: c.place, permalink: '' },
      origin: { channel: c.conversation.chat, ts: '' },
    }
    log('tell', c.place)
    closedTo(key, task)   // the owner's words reopen a closed thread
    noteTrust(key, task)
    const r = d.task(key, task, Date.now())
    if (r === 'failed') { failed(task); return { refused: 'could not start a session there' } }
    return r === 'held' ? { ok: true, held: true } : { ok: true }
  }
  // kage relay allow, deny and list: which threads may use the SSM relay beyond the owner-trusted ones. deny cuts the live token too.
  function relay(action: string, key?: string): { ok: true; keys: string[] } | { refused: string } {
    if (action !== 'list') {
      if (!key || !ssmEligible(key) || key.includes('#')) return { refused: 'that is not a Slack thread key (lanes are not listed)' }
      if (action === 'allow' && !store.conversation(key)) return { refused: 'no thread with that key' }
      store.setRelayAllow(key, action === 'allow')
      if (action === 'deny') o.dropRelay(key)
      log('relay', action, key)
    }
    return { ok: true, keys: store.relayAllowed() }
  }
  // kage say, from an app on this Mac: the owner's words posted as them, then run as their task (connectors/slack.ts say).
  // A new message goes to the DM with Kage. A reply goes only into that DM or a thread Kage already works in.
  async function say(text: string, at?: { channel: string; thread_ts: string }): Promise<{ ok: true; channel: string; ts: string } | { refused: string }> {
    const kind = !at ? undefined : at.channel === o.botDm ? 'dm' : store.conversation(`${at.channel}:${at.thread_ts}`)?.conversation.kind
    if (at && !kind) return { refused: 'Kage has no thread there' }
    try {
      const r = await o.post(text, at && kind && { ...at, kind })
      log('say', r.channel)
      return { ok: true, ...r }
    } catch (e) { return { refused: `Slack refused the post: ${(e as { data?: { error?: string } }).data?.error ?? (e as Error).message}` } }
  }
  return { status, tell, relay, say }
}
