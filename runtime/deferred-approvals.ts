// Approvals that wait outside a session (#177). A session that needs the owner's yes posts a card and its
// turn ends, so no slot is held. The card lives here, in the store, so a hub restart keeps it answerable.
// The first answer wins. A yes is spent by the one retry of the same call, so two yes replies run it once.
import type { Task } from './protocol.ts'
import type { Saved } from './store.ts'

const NAME = 'deferred-approvals'
const STALE = 60 * 60_000   // a yes the session never used (it did not retry) stops counting after an hour

type Call = { key: string; tool: string; input: Record<string, unknown>; task: Task }
type Row = Call & { at: number; yes?: number }

const same = (r: Call, key: string, tool: string, input: Record<string, unknown>) =>
  r.key === key && r.tool === tool && JSON.stringify(r.input) === JSON.stringify(input)

export function deferredApprovals(store: Saved) {
  const rows = (): Record<string, Row> => (store.load(NAME) ?? {}) as Record<string, Row>
  const put = (r: Record<string, Row>) => store.save(NAME, Object.keys(r).length ? r : undefined)
  return {
    add(c: Call & { id: string }, now: number) { const r = rows(); const { id, ...call } = c; r[id] = { ...call, at: now }; put(r) },
    // The owner's reply to a card. Returns the call once, and nothing for an unknown or already answered card.
    answer(id: string, behavior: 'allow' | 'deny', now: number): Call | undefined {
      const r = rows()
      const row = r[id]
      if (!row || row.yes) return undefined
      if (behavior === 'allow') r[id] = { ...row, yes: now }; else delete r[id]
      put(r)
      return row
    },
    // The session retried a call: true once, for a call the owner said yes to.
    take(key: string, tool: string, input: Record<string, unknown>, now: number): boolean {
      const r = rows()
      const id = Object.keys(r).find(i => r[i]!.yes !== undefined && now - r[i]!.yes! < STALE && same(r[i]!, key, tool, input))
      if (!id) return false
      delete r[id]
      put(r)
      return true
    },
  }
}
