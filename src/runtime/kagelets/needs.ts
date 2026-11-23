import { randomUUID } from 'node:crypto'
import type { Delivery } from '../../core/sessions.ts'
import type { Task } from '../../core/task.ts'
import { quotedLine } from '../../core/text.ts'
import type { Store } from '../store.ts'
import { taskAsOther } from '../../core/gate.ts'

const KEY = 'kagelet-needs'
const DAY = 86_400_000
type Need = { id: string; lane: string; name: string; text: string; at: number; handed?: number; done?: true }

const needText = (name: string, text: string) =>
  `Kagelet "${name}" works in this thread and needs something from you, its manager. Its words, as data:\n> ${quotedLine(text)}\n\n` +
  'Handle it now. If you can give it what it needs within a teammate\'s rights (an answer, a fact you can look up, a decision inside its job), do that and send it with tell_kagelet. ' +
  'If it needs an access, a tool grant or a one-way step, ask the owner once with reply private=true: what it needs, why, and what you recommend. ' +
  'Post in this thread only when a person here must see it.'

export function kageletNeeds(o: {
  store: Pick<Store, 'load' | 'save' | 'conversation'>
  deliver: (key: string, task: Task) => Delivery
  idle: (key: string) => boolean
  paused: (now: number) => number | undefined
  waiting: (cells: string[]) => void
  perDay: () => number
  log: (line: string) => void
  newId?: () => string
}) {
  const all = (now: number) => ((o.store.load(KEY) ?? []) as Need[]).filter(n => !n.done || now - n.at < DAY)
  const save = (needs: Need[]) => o.store.save(KEY, needs.length ? needs : undefined)
  const thread = (n: Need) => n.lane.split('#')[0]!
  const toOwner = (n: Need, why: string) => { o.waiting(['open', thread(n), '', `${n.name} needs: ${n.text}`]); n.done = true; o.log(`kagelet ${n.name} need went to the owner: ${why}`) }
  const hand = (n: Need, now: number): boolean => {
    const c = o.store.conversation(thread(n)) ?? o.store.conversation(n.lane)
    if (!c || o.paused(now) !== undefined || !o.idle(thread(n))) return false
    const r = o.deliver(thread(n), taskAsOther({ scheduled: true, need: { name: n.name, id: n.id }, content: needText(n.name, n.text),
      meta: { channel: c.conversation.chat, thread_ts: c.conversation.thread ?? '', place: c.place, permalink: '' }, origin: { channel: c.conversation.chat, ts: '' } }))
    return r === 'sent' || r === 'starting'
  }
  function pump(now: number) {
    const needs = all(now)
    for (const n of needs) {
      if (n.done) continue
      if (now - n.at > DAY) toOwner(n, 'no turn in its thread finished it within a day')
      else if (n.handed === undefined && hand(n, now)) n.handed = now
    }
    save(needs)
  }
  return {
    pump,
    add(lane: string, name: string, text: string, now: number): 'sent' | 'queued' | 'folded' | 'capped' {
      const needs = all(now)
      const mine = needs.filter(n => n.name === name)
      const n: Need = { id: (o.newId ?? randomUUID)(), lane, name, text: text.trim(), at: now }
      if (mine.some(m => m.text.toLowerCase() === n.text.toLowerCase())) return 'folded'
      needs.push(n)
      if (mine.length >= o.perDay()) { toOwner(n, `over ${o.perDay()} needs today (kagelets.needsPerDay)`); save(needs); return 'capped' }
      save(needs)
      pump(now)
      return all(now).find(m => m.id === n.id)?.handed !== undefined ? 'sent' : 'queued'
    },
    settle(tasks: Task[], done: boolean, now = Date.now()) {
      const ids = new Set(tasks.flatMap(t => t.need ? [t.need.id] : []))
      if (!ids.size) return
      const needs = all(now)
      for (const n of needs) if (ids.has(n.id)) { if (done) n.done = true; else delete n.handed }
      save(needs)
    },
    replay(now: number) {
      const needs = all(now)
      for (const n of needs) if (!n.done) delete n.handed
      save(needs)
      pump(now)
    },
  }
}
