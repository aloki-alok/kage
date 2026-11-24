import { senderOf } from '../core/gate.ts'
import type { Task } from '../core/task.ts'
import { answerLines, openTypedAsks, ownerWords, type TrustMode } from '../core/trust.ts'
import type { Ledgers } from '../runtime/ledger.ts'
import type { Store } from '../runtime/store.ts'

type Options = {
  store: Store; ledgers: Ledgers; mode: () => TrustMode; event: (detail: string) => void; now?: () => number
}

const typedByOwner = (t: Task) => senderOf(t) === 'owner' && !t.scheduled && !t.job && !t.need && !t.handoff && t.meta.channel !== 'voice'

export function trustHub(o: Options) {
  const now = () => o.now?.() ?? Date.now()
  function learn(key: string, t: Task) {
    const words = ownerWords(t.content)
    const asks = words === undefined ? [] : openTypedAsks(o.ledgers.text('waiting'), key)
    if (!asks.length) return
    const lines = answerLines(asks, words!)
    for (const a of asks) {
      const real = lines.find(l => l.who === a.who && l.kind === a.kind && l.reach === a.reach)
      o.ledgers.add('trust-shadow', [key, a.who, a.kind, a.reach, a.would, real ? real.answer : 'other'])
      o.event(`${o.mode()} answer ${a.would === 'go' && real?.answer === 'yes' || a.would === 'no' && real?.answer === 'no' ? 'match' : a.would === 'ask' ? 'asked' : 'differ'}`)
    }
    for (const l of lines) o.store.addTrustLine({ ...l, link: t.meta.permalink || key }, now())
  }
  return {
    heard(key: string, t: Task) {
      if (o.mode() === 'off') return
      if (typedByOwner(t)) learn(key, t)
    },
    command(action: string, id: string): { ok: true; text: string } | { refused: string } {
      if (action === 'revoke') return o.store.revokeTrust(id) ? { ok: true, text: `revoked ${id}` } : { refused: `no line ${id} to revoke` }
      return { refused: 'use revoke' }
    },
  }
}

export function trustFor(o: { store: Store; ledgers: Ledgers; mode: () => TrustMode }) {
  const hub = trustHub({ store: o.store, ledgers: o.ledgers, mode: o.mode, event: detail => o.ledgers.event({ kind: 'trust', who: 'hub', trace: '', detail }) })
  return { ...hub, session: { mode: o.mode, lines: () => o.store.trustLines() } }
}
