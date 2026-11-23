import { costRows, openWaiting } from './ledgers.ts'
import type { KageEvent } from './events.ts'
import type { KageletRow } from './kagelets/kagelet.ts'

type AwayFacts = {
  hours: number; replies: number; threads: number; usd: number; kageletRuns: number; lessons: number
  needsYou: { what: string; thread: string }[]; kagelets: { on: number; total: number }
}

const DAY = 86_400_000
const REPLY_BY = new Set(['bot', 'owner'])
const KEPT = /^(approved|edited) /
const SHOWN_ASKS = 3

const rows = (tsv: string) => tsv.split('\n').filter(Boolean).map(l => l.split('\t'))

export function awaySince(raw: string | undefined, now: number): number {
  const t = Number(raw)
  if (!(t > 0) || t > now) return now - DAY
  return Math.max(t, now - 7 * DAY)
}

export function awayFacts(o: { posted: string; costs: string; runs: string; waiting: string; events: KageEvent[]; kagelets: KageletRow[]; since: number; now: number }): AwayFacts {
  const after = (when: string | undefined) => Date.parse(when ?? '') >= o.since
  const replies = rows(o.posted).filter(([when, , , by]) => after(when) && REPLY_BY.has(by ?? ''))
  const usd = costRows(o.costs).filter(r => r.at >= o.since).reduce((a, r) => a + r.usd, 0)
  return {
    hours: Math.max(0, Math.round((o.now - o.since) / 3_600_000)),
    replies: replies.length,
    threads: new Set(replies.map(r => r[4])).size,
    usd: Math.round(usd * 100) / 100,
    kageletRuns: rows(o.runs).filter(([when, id]) => after(when) && id?.startsWith('kagelet-')).length,
    lessons: o.events.filter(e => e.kind === 'memory-decision' && after(e.at) && KEPT.test(e.detail)).length,
    needsYou: openWaiting(o.waiting).map(w => ({ what: w.what, thread: w.thread })),
    kagelets: { on: o.kagelets.filter(k => k.state === 'runs').length, total: o.kagelets.length },
  }
}

const times = (n: number) => n === 1 ? 'once' : `${n} times`
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`

export function awayLines(f: AwayFacts): { head: string; did: string[]; needsYou: string[]; kagelets?: string } {
  const did = [
    f.replies ? `answered ${times(f.replies)} in ${plural(f.threads, 'thread')}` : '',
    f.kageletRuns ? `ran kagelets ${times(f.kageletRuns)}` : '',
    f.lessons ? `kept ${plural(f.lessons, 'new lesson')}` : '',
    f.usd > 0 ? `spent $${f.usd.toFixed(2)}` : '',
  ].filter(Boolean)
  const asks = f.needsYou.map(n => n.what)
  return {
    head: f.hours ? `While you were away (${f.hours} h)` : 'Since you last looked',
    did: did.length ? did : ['all quiet, nothing came in'],
    needsYou: asks.length > SHOWN_ASKS ? [...asks.slice(0, SHOWN_ASKS), `and ${asks.length - SHOWN_ASKS} more (kage top)`] : asks,
    ...(f.kagelets.total && { kagelets: `${f.kagelets.on} of ${plural(f.kagelets.total, 'kagelet')} on` }),
  }
}
