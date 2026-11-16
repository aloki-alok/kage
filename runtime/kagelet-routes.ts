// Routing one kagelet's output or message to another (#93).
import { randomUUID } from 'node:crypto'
import { covers, MAX_CHAIN, parseKagelet, kageletRows, type Kagelet } from '../core/kagelets.ts'
import { handoffDetail, whoOf } from '../core/events.ts'
import { loopGuard } from '../core/agents.ts'
import { messageInput, parseMessage, type KageletMessage } from '../core/kagelet-message.ts'
import type { Store } from './store.ts'
import type { Ledgers, runEvents } from './ledger.ts'
import type { Task } from '../core/task.ts'
import type { Delivery } from '../core/sessions.ts'
import { readKagelets } from './kagelet-files.ts'
import { kageletPrompt } from './kagelet-sync.ts'

// The one path a kagelet's output or message takes to another kagelet (#93), routed by the hub with no Kage turn:
// after: <kagelet> when a run ends with an output, and message_kagelet in the middle of a run. Each is one envelope
// (core/kagelet-message.ts), checked and stored before delivery. It never goes into a running turn: it waits in
// the store until its target is idle, then starts a turn of its own. Only that turn's normal end acknowledges it,
// by its id (settle). Any other end (the usage limit, a cut, a stop, a closed session, a crash) puts it back in
// the queue, and the hub's clock hands it out again. The limit pause never owes it a replay.
// A chain starts at a run a schedule or a person started. It stops at a step that needs something, had a call
// refused or filed no report, and Kage gets it on its waiting list.
// ponytail: a chain's spend lives in memory, so a hub restart starts it over. A chain quiet for a day is dropped.
export function kageletRoutes(o: {
  dir: string; store: Pick<Store, 'conversation' | 'putMessage' | 'messageState' | 'handed' | 'unread'>
  ledgers: Pick<Ledgers, 'add' | 'text' | 'event'>; runs: ReturnType<typeof runEvents>
  deliver: (key: string, task: Task) => Delivery
  // Ready for a turn of its own now: no turn running or starting, no closed thread, and a session slot it can take.
  idle: (key: string) => boolean
  // The usage-limit pause (runtime/limit-pause.ts) and its reset time: no message goes, and none ages.
  paused: (now: number) => number | undefined
  capUsd?: number; chainUsd?: number; log: (line: string) => void; newId?: () => string
  // Its approved memory notes (runtime/kagelet-memory.ts), carried in a run a handoff starts as in a scheduled one.
  memory?: (name: string) => { file: string; text: string }[]
}) {
  const chains = new Map<string, { usd: number; at: number }>()
  // 20 a minute per pair, as for a teammate's agent (core/agents.ts). Hops travel in each message and on its run.
  const guard = loopGuard({ perWindow: 20, windowMs: 60_000, hops: Infinity })
  const chainOf = (id: string, now: number) => {
    for (const [k, c] of chains) if (c.at < now - 86_400_000) { chains.delete(k); guard.person(k) }
    const c = chains.get(id) ?? chains.set(id, { usd: 0, at: now }).get(id)!
    c.at = Math.max(c.at, now)
    return c
  }
  const outputs = new Map<string, { needs: string; output: string }>()   // lane -> its run's report
  const laneOf = (name: string) => kageletRows(readKagelets(o.dir), { runs: '', costs: '', now: 0 }).find(r => r.name === name)?.key ?? ''
  const stop = (key: string, chain: string, why: string) => {
    o.runs.emit(key, 'handoff', `stopped: ${why}`)
    o.ledgers.add('waiting', ['open', key.split('#')[0]!, '', `chain ${chain} stopped at ${whoOf(key)}: ${why}`])
  }
  // Why a stored message can never go to its target, 'waits' while it cannot go yet, or the task it starts there.
  function check(m: KageletMessage, now: number): { why: string } | 'waits' | { key: string; task: Task } {
    const all = readKagelets(o.dir)
    const rows = kageletRows(all, { runs: o.ledgers.text('runs'), costs: o.ledgers.text('costs'), now })
    const row = rows.find(r => r.name === m.to), sp = all.find(f => f.name === m.to)
    const from = rows.find(r => r.name === m.from)
    const c = chainOf(m.contextId, now)
    // A message is untrusted input (its sender may read the web): it never reaches a kagelet that holds more.
    const wider = row?.tools.find(t => !covers(from?.tools ?? [], t))
    const why = !row || !sp ? `there is no kagelet named "${m.to}"`
      : row.state === 'broken' ? `${m.to} is broken (${row.error})`
      : wider ? `${m.to} holds ${wider}, which ${m.from} does not. A kagelet messages only one with the same tools or fewer.`
      : o.chainUsd !== undefined && c.usd >= o.chainUsd ? `the chain spent $${c.usd.toFixed(2)}, at or over its cap of $${o.chainUsd.toFixed(2)} (kagelets.chainUsd)`
      : m.hops > MAX_CHAIN - 1 ? `${m.hops} hops with no person or schedule in between (the limit is ${MAX_CHAIN - 1})`
      : undefined
    if (why) return { why }
    // A paused kagelet, or one at its daily cap, keeps its messages until it runs again or they expire.
    const conversation = o.store.conversation(row!.key!)
    if (row!.state === 'paused' || o.capUsd !== undefined && row!.costToday >= o.capUsd || !conversation || o.paused(now) !== undefined || !o.idle(row!.key!)) return 'waits'
    return { key: row!.key!, task: {
      type: 'task', fromOwner: false, scheduled: true, handoff: { chain: m.contextId, message: m.messageId, hops: m.hops },
      content: `${kageletPrompt(parseKagelet(m.to, sp!.text) as Kagelet, o.memory?.(m.to))}\n\n${messageInput(m)}`,
      meta: { channel: conversation.conversation.chat, thread_ts: conversation.conversation.thread ?? '', place: conversation.place, permalink: '' },
      origin: { channel: conversation.conversation.chat, ts: '' },
    } }
  }
  const kindOf = (m: KageletMessage) => /^https?:\/\//.test(m.parts[0]!.text) ? 'link' : 'note'
  const fail = (m: KageletMessage, why: string) => {
    o.ledgers.event({ kind: 'handoff', who: m.from, trace: m.taskId, chain: m.contextId, detail: handoffDetail(m.to, kindOf(m), why) })
    o.store.messageState(m.messageId, 'failed', why)
    o.ledgers.add('waiting', ['open', laneOf(m.from).split('#')[0]!, '', `chain ${m.contextId} stopped before ${m.to}: ${why}`])
    o.log(`chain ${m.contextId}: ${m.from} > ${m.to} failed: ${why}`)
  }
  // A stored message to its idle target as a turn of its own. 'sent', 'waits' or why it failed for good.
  function deliver(m: KageletMessage, now: number): string {
    const ok = check(m, now)
    if (ok === 'waits') return 'waits'
    if ('why' in ok) { fail(m, ok.why); return ok.why }
    // Only a session that started counts. The idle check rules out a hold, a closed thread, a busy session and a full
    // house, so anything else means it did not start.
    const r = o.deliver(ok.key, ok.task)
    if (r !== 'sent' && r !== 'starting') return 'waits'
    o.store.handed(m.messageId, now)
    o.ledgers.add('runs', [`kagelet-${m.to}`, ok.key])   // as the scheduler's ran(): kage logs and lastRun read it
    o.ledgers.event({ kind: 'handoff', who: m.from, trace: m.taskId, chain: m.contextId, detail: handoffDetail(m.to, kindOf(m)) })
    return 'sent'
  }
  // A new message from a running kagelet: built, checked, stored, then delivered now or once its target is idle.
  // handoff: an after: output, which no one sees refused, so a refusal stops its chain.
  function send(fromKey: string, to: string, text: string, now: number, handoff = false): string {
    const run = o.runs.of(fromKey)
    if (!run) return 'not sent: this run is not open'
    const chain = run.chain ||= run.trace
    const m = parseMessage({ messageId: (o.newId ?? randomUUID)(), contextId: chain, taskId: run.trace, from: whoOf(fromKey), to, role: 'agent',
      parts: [{ kind: 'text', text }], hops: run.hops + 1 })
    if ('error' in m) {
      if (handoff) stop(fromKey, chain, `its output could not go to ${to}: ${m.error}`)
      return `not sent: ${m.error}`
    }
    // Counted once, when sent: a message waiting for its target is not a new turn.
    const flood = guard.turn(`${m.from}>${m.to}`, chain, now)
    o.store.putMessage(m, now)
    if (flood) { fail(m, flood); return `not sent: ${flood}` }
    const r = deliver(m, now)
    return r === 'sent' ? `sent to ${to}` : r === 'waits' ? `queued for ${to}, which is busy or paused: it reads this in a turn of its own once it can` : `not sent: ${r}`
  }
  // On the hub's clock: a queued message an hour past its first run (or its sending, if no run took it yet) fails;
  // each idle kagelet takes its oldest waiting one. A running turn ends on its own, so a delivered one never expires.
  // A usage-limit pause stops that hour: it counts again from the reset.
  let resumed = 0
  function pump(now: number) {
    const reset = o.paused(now)
    if (reset !== undefined) { resumed = reset; return }
    for (const u of o.store.unread()) {
      if (u.state !== 'queued') continue
      if (now - Math.max(u.tried ?? u.at, resumed) > 3_600_000) fail(u.message, 'no run of its target finished it within an hour')
      else deliver(u.message, now)
    }
  }
  return {
    message(fromKey: string, to: string, text: string, now = Date.now()): string {
      if (whoOf(fromKey) === fromKey) return 'not sent: only a kagelet can message a kagelet'
      return send(fromKey, to, text, now)
    },
    pump,
    // The end of a turn that carried messages: read only when it ended normally (done), else queued again.
    settle(tasks: Task[], done: boolean) {
      for (const t of tasks) if (t.handoff) o.store.messageState(t.handoff.message, done ? 'read' : 'queued')
    },
    // At the start: a message no turn finished (the hub stopped first) waits again.
    // Its hour counts from this start: no run could take it while the hub was down, and a pause's reset died with it.
    replay(now: number) {
      resumed = now
      for (const u of o.store.unread()) if (u.state === 'delivered') o.store.messageState(u.message.messageId, 'queued')
      pump(now)
    },
    // The report tool: what the run needs and its output, for its end.
    reported(key: string, r: { needs: string; output: string }) { outputs.set(key, r) },
    // A turn ended with its result: stop the chain on a failed step, else hand the output on; then end the run.
    // limited: it ended on the usage limit and did nothing, so only its spend counts. Its message runs again.
    ended(key: string, usd: number, transcript: string, now = Date.now(), limited = false) {
      const run = o.runs.of(key)
      const out = outputs.get(key)
      outputs.delete(key)
      if (run?.chain) chainOf(run.chain, now).usd += usd
      if (run && !limited && key.includes('#side-kagelet-')) {
        const name = whoOf(key)
        const why = !run.reported ? 'ended without a report' : out?.needs ? `needs ${out.needs}` : run.refused ? 'a tool call was refused, so it needs approval' : undefined
        const next = readKagelets(o.dir).map(f => parseKagelet(f.name, f.text)).filter((p): p is Kagelet => !('error' in p) && p.after === name)
        if (why && run.chain) stop(key, run.chain, why)
        else if (!why && out?.output && next.length) {
          if (!run.chain) { run.chain = run.trace; chainOf(run.chain, now).usd += usd }
          for (const n of next) send(key, n.name, out.output, now, true)
        }
      }
      o.runs.end(key, `$${usd.toFixed(2)}`, transcript)
    },
  }
}
