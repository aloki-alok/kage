import { randomUUID } from 'node:crypto'
import { covers, MAX_CHAIN, parseKagelet, kageletRows, type Kagelet } from '../../core/kagelets/kagelet.ts'
import { handoffDetail, whoOf } from '../../core/events.ts'
import { loopGuard } from '../../core/agents.ts'
import { messageInput, parseMessage, type KageletMessage } from '../../core/kagelets/message.ts'
import type { Store } from '../store.ts'
import type { Ledgers, runEvents } from '../ledger.ts'
import type { Task } from '../../core/task.ts'
import type { Delivery } from '../../core/sessions.ts'
import { readKagelets } from './files.ts'
import { kageletPrompt } from './sync.ts'
import { taskAsOther } from '../../core/gate.ts'

type Options = {
  dir: string; store: Pick<Store, 'conversation' | 'putMessage' | 'messageState' | 'handed' | 'unread'>
  ledgers: Pick<Ledgers, 'add' | 'text' | 'event'>; runs: ReturnType<typeof runEvents>
  deliver: (key: string, task: Task) => Delivery
  idle: (key: string) => boolean
  granted: (key: string) => boolean
  paused: (now: number) => number | undefined
  capUsd?: number; chainUsd?: number; log: (line: string) => void; newId?: () => string
  memory?: (name: string) => { file: string; text: string }[]
  done?: (key: string, failure: string | undefined, transcript: string, now: number, trace: string) => void
}
type Routes = {
  o: Options; chains: Map<string, { usd: number; at: number }>; guard: ReturnType<typeof loopGuard>
  outputs: Map<string, { needs: string; output: string }>; resumed: number
}

export function kageletRoutes(o: Options) {
  const r: Routes = { o, chains: new Map(), guard: loopGuard({ perWindow: 20, windowMs: 60_000, hops: Infinity }), outputs: new Map(), resumed: 0 }
  return {
    message(fromKey: string, to: string, text: string, now = Date.now()): string {
      if (whoOf(fromKey) === fromKey) return 'not sent: only a kagelet can message a kagelet'
      return send(r, fromKey, to, text, now)
    },
    pump: (now: number) => pump(r, now),
    settle(tasks: Task[], done: boolean) {
      for (const t of tasks) if (t.handoff) o.store.messageState(t.handoff.message, done ? 'read' : 'queued')
    },
    replay(now: number) {
      r.resumed = now
      for (const u of o.store.unread()) if (u.state === 'delivered') o.store.messageState(u.message.messageId, 'queued')
      pump(r, now)
    },
    reported(key: string, out: { needs: string; output: string }) { r.outputs.set(key, out) },
    ended: (key: string, usd: number, transcript: string, now = Date.now(), limited = false, error?: string) => ended(r, key, usd, transcript, now, limited, error),
  }
}

function chainOf({ chains, guard }: Routes, id: string, now: number) {
  for (const [k, c] of chains) if (c.at < now - 86_400_000) { chains.delete(k); guard.person(k) }
  const c = chains.get(id) ?? chains.set(id, { usd: 0, at: now }).get(id)!
  c.at = Math.max(c.at, now)
  return c
}

const laneOf = (o: Options, name: string) => kageletRows(readKagelets(o.dir), { runs: '', costs: '', now: 0 }).find(r => r.name === name)?.key ?? ''

function stop(o: Options, key: string, chain: string, why: string) {
  o.runs.emit(key, 'handoff', `stopped: ${why}`)
  o.ledgers.add('waiting', ['open', key.split('#')[0]!, '', `chain ${chain} stopped at ${whoOf(key)}: ${why}`])
}

function check(r: Routes, m: KageletMessage, now: number): { why: string } | 'waits' | { key: string; task: Task } {
  const { o } = r
  const all = readKagelets(o.dir)
  const rows = kageletRows(all, { runs: o.ledgers.text('runs'), costs: o.ledgers.text('costs'), now })
  const row = rows.find(r => r.name === m.to), sp = all.find(f => f.name === m.to)
  const from = rows.find(r => r.name === m.from)
  const c = chainOf(r, m.contextId, now)
  const wider = row?.tools.find(t => !covers(from?.tools ?? [], t))
  const why = !row || !sp ? `there is no kagelet named "${m.to}"`
    : row.state === 'broken' ? `${m.to} is broken (${row.error})`
    : wider ? `${m.to} holds ${wider}, which ${m.from} does not. A kagelet messages only one with the same tools or fewer.`
    : o.chainUsd !== undefined && c.usd >= o.chainUsd ? `the chain spent $${c.usd.toFixed(2)}, at or over its cap of $${o.chainUsd.toFixed(2)} (kagelets.chainUsd)`
    : m.hops > MAX_CHAIN - 1 ? `${m.hops} hops with no person or schedule in between (the limit is ${MAX_CHAIN - 1})`
    : undefined
  if (why) return { why }
  const conversation = o.store.conversation(row!.key!)
  if (row!.state === 'paused' || o.capUsd !== undefined && row!.costToday >= o.capUsd || !conversation || o.paused(now) !== undefined || !o.idle(row!.key!)) return 'waits'
  if (!o.granted(row!.key!)) return { why: `${m.to} does not run here: it is past this install's kagelet limit (kagelets.max)` }
  return { key: row!.key!, task: taskFor(o, m, sp!, conversation) }
}

function taskFor(o: Options, m: KageletMessage, sp: { name: string; text: string }, conversation: NonNullable<ReturnType<Store['conversation']>>): Task {
  return taskAsOther({
    scheduled: true, handoff: { chain: m.contextId, message: m.messageId, hops: m.hops },
    content: `${kageletPrompt(parseKagelet(m.to, sp.text) as Kagelet, o.memory?.(m.to))}\n\n${messageInput(m)}`,
    meta: { channel: conversation.conversation.chat, thread_ts: conversation.conversation.thread ?? '', place: conversation.place, permalink: '' },
    origin: { channel: conversation.conversation.chat, ts: '' },
  })
}

const kindOf = (m: KageletMessage) => /^https?:\/\//.test(m.parts[0]!.text) ? 'link' : 'note'

function fail(o: Options, m: KageletMessage, why: string) {
  o.ledgers.event({ kind: 'handoff', who: m.from, trace: m.taskId, chain: m.contextId, detail: handoffDetail(m.to, kindOf(m), why) })
  o.store.messageState(m.messageId, 'failed', why)
  o.ledgers.add('waiting', ['open', laneOf(o, m.from).split('#')[0]!, '', `chain ${m.contextId} stopped before ${m.to}: ${why}`])
  o.log(`chain ${m.contextId}: ${m.from} > ${m.to} failed: ${why}`)
}

function deliver(r: Routes, m: KageletMessage, now: number): string {
  const { o } = r
  const ok = check(r, m, now)
  if (ok === 'waits') return 'waits'
  if ('why' in ok) { fail(o, m, ok.why); return ok.why }
  const sent = o.deliver(ok.key, ok.task)
  if (sent !== 'sent' && sent !== 'starting') return 'waits'
  o.store.handed(m.messageId, now)
  o.ledgers.add('runs', [`kagelet-${m.to}`, ok.key])
  o.ledgers.event({ kind: 'handoff', who: m.from, trace: m.taskId, chain: m.contextId, detail: handoffDetail(m.to, kindOf(m)) })
  return 'sent'
}

function send(r: Routes, fromKey: string, to: string, text: string, now: number, handoff = false): string {
  const { o } = r
  const run = o.runs.of(fromKey)
  if (!run) return 'not sent: this run is not open'
  const chain = run.chain ||= run.trace
  const m = parseMessage({ messageId: (o.newId ?? randomUUID)(), contextId: chain, taskId: run.trace, from: whoOf(fromKey), to, role: 'agent',
    parts: [{ kind: 'text', text }], hops: run.hops + 1 })
  if ('error' in m) {
    if (handoff) stop(o, fromKey, chain, `its output could not go to ${to}: ${m.error}`)
    return `not sent: ${m.error}`
  }
  const flood = r.guard.turn(`${m.from}>${m.to}`, chain, now)
  o.store.putMessage(m, now)
  if (flood) { fail(o, m, flood); return `not sent: ${flood}` }
  const d = deliver(r, m, now)
  return d === 'sent' ? `sent to ${to}` : d === 'waits' ? `queued for ${to}, which is busy or paused: it reads this in a turn of its own once it can` : `not sent: ${d}`
}

function pump(r: Routes, now: number) {
  const { o } = r
  const reset = o.paused(now)
  if (reset !== undefined) { r.resumed = reset; return }
  for (const u of o.store.unread()) {
    if (u.state !== 'queued') continue
    if (now - Math.max(u.tried ?? u.at, r.resumed) > 3_600_000) fail(o, u.message, 'no run of its target finished it within an hour')
    else deliver(r, u.message, now)
  }
}

function ended(r: Routes, key: string, usd: number, transcript: string, now = Date.now(), limited = false, error?: string) {
  const { o } = r
  const run = o.runs.of(key)
  const out = r.outputs.get(key)
  r.outputs.delete(key)
  if (run?.chain) chainOf(r, run.chain, now).usd += usd
  if (run && !limited && key.includes('#side-kagelet-')) {
    const name = whoOf(key)
    const why = !run.reported ? 'ended without a report' : out?.needs ? `needs ${out.needs}` : run.refused ? 'a tool call was refused, so it needs approval' : undefined
    const next = readKagelets(o.dir).map(f => parseKagelet(f.name, f.text)).filter((p): p is Kagelet => !('error' in p) && p.after === name)
    if (why && run.chain) stop(o, key, run.chain, why)
    else if (!why && out?.output && next.length) {
      if (!run.chain) { run.chain = run.trace; chainOf(r, run.chain, now).usd += usd }
      for (const n of next) send(r, key, n.name, out.output, now, true)
    }
  }
  o.runs.end(key, `$${usd.toFixed(2)}`, transcript)
  if (run && !limited) o.done?.(key, error ? `stopped with ${error}` : run.reported ? undefined : 'ended without a report', transcript, now, run.trace)
}
