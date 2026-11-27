import { createHash } from 'node:crypto'
import { heldCommand } from '../core/held.ts'
import type { Task } from '../core/task.ts'
import type { Saved } from './store.ts'

const NAME = 'deferred-approvals'
const DENY_HOLDS = 'deny-holds'
const YES_TTL = 60 * 60_000
const CARD_TTL = 24 * 60 * 60_000
const OPEN_PER_KEY = 5

type Review = 'run' | 'hold'
type Call = { key: string; tool: string; input: Record<string, unknown>; task: Task; review?: Review }
type Row = Call & { at: number; yes?: number }
type CardVerdict = { key: string; tool: string; kind: string; fp: string; owner: 'allow' | 'always' | 'deny' | 'expired'; review?: Review }

const same = (r: Call, key: string, tool: string, input: Record<string, unknown>) =>
  r.key === key && r.tool === tool && JSON.stringify(r.input) === JSON.stringify(input)

const fingerprint = (tool: string, input: Record<string, unknown>) => createHash('sha256').update(`${tool}\n${JSON.stringify(input)}`).digest('hex').slice(0, 12)
const holdKey = (key: string, tool: string, input: Record<string, unknown>) => `${key}\n${fingerprint(tool, input)}`

const verdictOf = (c: Call, owner: CardVerdict['owner']): CardVerdict => ({
  key: c.key, tool: c.tool, kind: (c.tool === 'Bash' && heldCommand(String(c.input.command ?? ''))) || c.tool,
  fp: fingerprint(c.tool, c.input), owner, ...c.review && { review: c.review },
})

export function deferredApprovals(store: Saved, heard: (v: CardVerdict) => void = () => {}, holdDays: () => number = () => 0) {
  const holdMs = () => holdDays() * 24 * 60 * 60_000
  const holds = (now: number): Record<string, number> => Object.fromEntries(Object.entries((store.load(DENY_HOLDS) ?? {}) as Record<string, number>).filter(([, at]) => now - at < holdMs()))
  const putHolds = (h: Record<string, number>) => store.save(DENY_HOLDS, Object.keys(h).length ? h : undefined)
  const rows = (): Record<string, Row> => (store.load(NAME) ?? {}) as Record<string, Row>
  const put = (r: Record<string, Row>) => store.save(NAME, Object.keys(r).length ? r : undefined)
  const sweep = (r: Record<string, Row>, now: number) => {
    for (const [i, w] of Object.entries(r)) {
      if (w.yes === undefined && now - w.at >= CARD_TTL) { delete r[i]; heard(verdictOf(w, 'expired')) }
      else if (w.yes !== undefined && (now - w.at >= CARD_TTL || now - w.yes >= YES_TTL)) delete r[i]
    }
  }
  return {
    add(c: Call & { id: string }, now: number) { const r = rows(); sweep(r, now); const { id, ...call } = c; r[id] = { ...call, at: now }; put(r) },
    answer(id: string, behavior: 'allow' | 'deny', now: number, always?: boolean): Call | undefined {
      const r = rows()
      const row = r[id]
      if (row && now - row.at >= CARD_TTL) { sweep(r, now); put(r); return undefined }
      if (!row || row.yes) return undefined
      if (behavior === 'allow') r[id] = { ...row, yes: now }; else delete r[id]
      put(r)
      if (behavior === 'deny' && holdMs() > 0) putHolds({ ...holds(now), [holdKey(row.key, row.tool, row.input)]: now })
      heard(verdictOf(row, behavior === 'deny' ? 'deny' : always ? 'always' : 'allow'))
      return row
    },
    waiting(key: string, tool: string, input: Record<string, unknown>, now: number): 'same' | 'full' | undefined {
      const r = rows()
      sweep(r, now)
      put(r)
      const open = Object.values(r).filter(w => w.key === key && w.yes === undefined)
      return open.some(w => same(w, key, tool, input)) ? 'same' : open.length >= OPEN_PER_KEY ? 'full' : undefined
    },
    pending: (key: string, now: number) => Object.values(rows()).some(w => w.key === key && w.yes === undefined && now - w.at < CARD_TTL),
    deniedAt(key: string, tool: string, input: Record<string, unknown>, now: number): number | undefined {
      return holds(now)[holdKey(key, tool, input)]
    },
    unhold(kagelet: string, now: number): number {
      const live = holds(now), ofKagelet = (k: string) => k.split('\n')[0]!.endsWith(`#side-kagelet-${kagelet}`)
      const lifted = Object.keys(live).filter(ofKagelet)
      putHolds(Object.fromEntries(Object.entries(live).filter(([k]) => !ofKagelet(k))))
      return lifted.length
    },
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

export function answerDeferred(a: ReturnType<typeof deferredApprovals>, send: (key: string, task: Task) => void, id: string, behavior: 'allow' | 'deny', now: number, always?: (c: Call) => void): boolean {
  const c = a.answer(id, behavior, now, !!always)
  if (!c) return false
  const text = behavior === 'allow' ? `The owner said yes to the card for ${c.tool}. Run that same call again now, with the same input.` : `The owner said no to the card for ${c.tool}. Do not run it. Tell the thread you stopped.`
  send(c.key, { ...c.task, content: `Approval answer: ${text}` })
  if (behavior === 'allow') always?.(c)
  return true
}
