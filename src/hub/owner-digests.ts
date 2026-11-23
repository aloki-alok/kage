import { readFileSync, writeFileSync } from 'node:fs'
import { dailyDue, expiredWaiting, grantsLine, heldLine, staleWaiting } from '../core/ledgers.ts'
import { retro, retroDue } from '../core/retro.ts'
import type { Ledgers } from '../runtime/ledger.ts'
import type { Store } from '../runtime/store.ts'

const readFile = (f: string) => { try { return readFileSync(f, 'utf8') } catch { return '' } }

export function ownerDigests(o: { dir: string; ledgers: Ledgers; store: Store; placeOf: (key: string) => string; costTracked: boolean; expireHours: () => number; notify:(text: string) => Promise<boolean> }) {
  const DAILY = `${o.dir}/daily-sent`, RETRO = `${o.dir}/retro-sent`
  return {
    async dailyNote(now: number) {
      const today = dailyDue(now, readFile(DAILY).trim() || undefined)
      if (!today) return
      const hours = o.expireHours(), tsv = o.ledgers.text('waiting')
      const expired = expiredWaiting(tsv, now, hours * 3600_000)
      const gone = new Set(expired.map(i => i.thread))
      const stale = staleWaiting(tsv, now, 24 * 3600_000).filter(i => !gone.has(i.thread))
      const at = Date.parse(`${today}T05:00:00Z`)
      const noCard = grantsLine(o.ledgers.text('grants'), at - 24 * 3600_000, at)
      const released = heldLine([...o.ledgers.events(new Date(at - 24 * 3600_000).toISOString().slice(0, 10)), ...o.ledgers.events(today)], at - 24 * 3600_000, at)
      const list = (title: string, items: typeof stale) => items.length ? [[`*${title} (${items.length})*`,
        ...items.map(i => `• ${i.link ? `<${i.link}|${i.what}>` : i.what} (since ${i.when.slice(0, 10)})`)].join('\n')] : []
      const parts = [...list('Still waiting on you', stale), ...list(`Dropped after ${hours} h. Reply in its thread if one still matters`, expired), ...noCard ? [noCard] : [], ...released ? [released] : []]
      const sent = !parts.length || await o.notify(parts.join('\n\n'))
      if (!sent) return
      const still = new Set(expiredWaiting(o.ledgers.text('waiting'), now, hours * 3600_000).map(i => i.thread))
      for (const thread of gone) if (still.has(thread)) o.ledgers.add('waiting', ['expired', thread, '', ''])
      writeFileSync(DAILY, today, { mode: 0o600 })
    },
    async weeklyRetro(now: number) {
      const last = Number(readFile(RETRO)) || undefined
      if (!retroDue(now, last)) return
      const lines = retro({ schedules: o.store.schedules(), placeOf: o.placeOf, runs: o.ledgers.text('runs'), posted: o.ledgers.text('posted'), costs: o.ledgers.text('costs'), costTracked: o.costTracked, now })
      const sent = !lines.length || await o.notify(['*Weekly retro*, from what Kage did this week.', ...lines].join('\n'))
      if (sent) writeFileSync(RETRO, String(now), { mode: 0o600 })
    },
  }
}
