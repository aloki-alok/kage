import { senderOf, teammateOf } from '../core/gate.ts'
import { threadOfJobLane } from '../core/conversations.ts'
import type { Task } from '../core/task.ts'
import { answerLines, decide, openTypedAsks, ownerWords, type TrustMode } from '../core/trust.ts'
import type { Ledgers } from '../runtime/ledger.ts'
import type { Store } from '../runtime/store.ts'

type Options = {
  store: Store; ledgers: Ledgers; mode: () => TrustMode; teammates: () => string[]
  threadStarter: (key: string) => Promise<string | undefined>; event: (detail: string) => void; now?: () => number
}

const RELAY = { kind: 'ssm-relay', reach: 'ssm' }
const UNKNOWN_SENDER = '?'

const typedByOwner = (t: Task) => senderOf(t) === 'owner' && !t.scheduled && !t.job && !t.need && !t.handoff && t.meta.channel !== 'voice'

export function trustHub(o: Options) {
  const now = () => o.now?.() ?? Date.now()
  const whoInThread = new Map<string, Set<string>>()
  const noteWho = (key: string, t: Task) => {
    const thread = threadOfJobLane(key)
    whoInThread.set(thread, (whoInThread.get(thread) ?? new Set()).add(teammateOf(t.content)?.id ?? UNKNOWN_SENDER))
  }
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
      else if (senderOf(t) !== 'owner') noteWho(key, t)
    },
    relayOk(key: string): boolean {
      if (o.store.relayOk(key)) return true
      const who = whoInThread.get(threadOfJobLane(key))
      if (o.mode() !== 'on' || !who?.size) return false
      const lines = o.store.trustLines()
      return [...who].every(w => decide(lines, { who: w, ...RELAY }).do === 'go')
    },
    async backfill() {
      if (o.mode() === 'off') return
      const known = new Set(o.teammates())
      for (const key of o.store.relayAllowed()) {
        const who = await o.threadStarter(key).catch(() => undefined)
        if (who && known.has(who)) o.store.proposeTrust({ who, ...RELAY, answer: 'yes', once: false, link: key, source: `relay_allow:${key}` }, now())
      }
    },
    command(action: string, id: string): { ok: true; text: string } | { refused: string } {
      if (action === 'confirm') {
        const n = o.store.confirmTrust(id)
        return n ? { ok: true, text: `confirmed ${n}` } : { refused: id === 'all' ? 'no proposed lines' : `no proposed line ${id}` }
      }
      if (action === 'revoke') return o.store.revokeTrust(id) ? { ok: true, text: `revoked ${id}` } : { refused: `no line ${id} to revoke` }
      return { refused: 'use confirm or revoke' }
    },
  }
}
