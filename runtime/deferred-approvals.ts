// Approvals that wait outside a session (#177). A session that needs the owner's yes posts a card and its
// turn ends, so no slot is held. The card lives here, in the store, so a hub restart keeps it answerable.
// The first answer wins. A yes is spent by the one retry of the same call, so two yes replies run it once.
import type { Task } from '../core/task.ts'
import type { Saved } from './store.ts'

const NAME = 'deferred-approvals'
const YES_TTL = 60 * 60_000   // a yes the session never used (it did not retry) stops counting after an hour
const CARD_TTL = 24 * 60 * 60_000   // a card nobody answered in a day is dropped: its call is long forgotten
// ponytail: one fixed cap on a kagelet lane's open cards, the needs cap's default (kagelets.needsPerDay); a setting if it binds.
const OPEN_PER_KEY = 5

type Call = { key: string; tool: string; input: Record<string, unknown>; task: Task }
type Row = Call & { at: number; yes?: number }

const same = (r: Call, key: string, tool: string, input: Record<string, unknown>) =>
  r.key === key && r.tool === tool && JSON.stringify(r.input) === JSON.stringify(input)

export function deferredApprovals(store: Saved) {
  const rows = (): Record<string, Row> => (store.load(NAME) ?? {}) as Record<string, Row>
  const put = (r: Record<string, Row>) => store.save(NAME, Object.keys(r).length ? r : undefined)
  // Rows nobody can use any more go on every write, so no timer is needed.
  const sweep = (r: Record<string, Row>, now: number) => { for (const [i, w] of Object.entries(r)) if (now - w.at >= CARD_TTL || (w.yes !== undefined && now - w.yes >= YES_TTL)) delete r[i] }
  return {
    add(c: Call & { id: string }, now: number) { const r = rows(); sweep(r, now); const { id, ...call } = c; r[id] = { ...call, at: now }; put(r) },
    // The owner's reply to a card. Returns the call once, and nothing for an unknown or already answered card.
    answer(id: string, behavior: 'allow' | 'deny', now: number): Call | undefined {
      const r = rows()
      const row = r[id]
      if (row && now - row.at >= CARD_TTL) { sweep(r, now); put(r); return undefined }
      if (!row || row.yes) return undefined
      if (behavior === 'allow') r[id] = { ...row, yes: now }; else delete r[id]
      put(r)
      return row
    },
    // Why no new card goes out for this call: 'same' when one is open for it already (a kagelet asks once per step),
    // 'full' when its lane has OPEN_PER_KEY open, so a looping kagelet cannot flood the owner's DM.
    waiting(key: string, tool: string, input: Record<string, unknown>, now: number): 'same' | 'full' | undefined {
      const r = rows()
      sweep(r, now)
      const open = Object.values(r).filter(w => w.key === key && w.yes === undefined)
      return open.some(w => same(w, key, tool, input)) ? 'same' : open.length >= OPEN_PER_KEY ? 'full' : undefined
    },
    // The session retried a call: true once, for a call the owner said yes to.
    take(key: string, tool: string, input: Record<string, unknown>, now: number): boolean {
      const r = rows()
      sweep(r, now)
      const id = Object.keys(r).find(i => r[i]!.yes !== undefined && same(r[i]!, key, tool, input))
      if (!id) { put(r); return false }
      delete r[id]
      put(r)
      return true
    },
  }
}

// The owner's reply to a waiting card: starts a turn in the thread that asked. false: no such open card.
export function answerDeferred(a: ReturnType<typeof deferredApprovals>, send: (key: string, task: Task) => void, id: string, behavior: 'allow' | 'deny', now: number): boolean {
  const c = a.answer(id, behavior, now)
  if (!c) return false
  const text = behavior === 'allow' ? `The owner said yes to the card for ${c.tool}. Run that same call again now, with the same input.` : `The owner said no to the card for ${c.tool}. Do not run it. Tell the thread you stopped.`
  send(c.key, { ...c.task, content: `Approval answer: ${text}` })
  return true
}
