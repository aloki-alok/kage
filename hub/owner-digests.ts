// What the owner gets on a clock: the daily note of questions that waited a day or more and the grants made with no
// card, and the Monday retro of what Kage's own ledgers say to change (core/retro.ts). Each marks its file only once
// its DM went out, so a failed post retries.
import { readFileSync, writeFileSync } from 'node:fs'
import { dailyDue, grantsLine, staleWaiting } from '../core/ledgers.ts'
import { retro, retroDue } from '../core/retro.ts'
import type { Ledgers } from '../runtime/ledger.ts'
import type { Store } from '../runtime/store.ts'

const readFile = (f: string) => { try { return readFileSync(f, 'utf8') } catch { return '' } }

export function ownerDigests(o: { dir: string; ledgers: Ledgers; store: Store; placeOf: (key: string) => string; costTracked: boolean; notify: (text: string) => Promise<boolean> }) {
  const DAILY = `${o.dir}/daily-sent`, RETRO = `${o.dir}/retro-sent`
  return {
    // Once a day from 05:00 UTC.
    async dailyNote(now: number) {
      const today = dailyDue(now, readFile(DAILY).trim() || undefined)
      if (!today) return
      const stale = staleWaiting(o.ledgers.text('waiting'), now, 24 * 3600_000)
      // The day before this note's 05:00 UTC, so a retried note neither skips nor repeats a grant.
      const at = Date.parse(`${today}T05:00:00Z`)
      const noCard = grantsLine(o.ledgers.text('grants'), at - 24 * 3600_000, at)
      const parts = [...stale.length ? [[`*Still waiting on you (${stale.length})*`,
        ...stale.map(i => `• ${i.link ? `<${i.link}|${i.what}>` : i.what} (since ${i.when.slice(0, 10)})`)].join('\n')] : [], ...noCard ? [noCard] : []]
      const sent = !parts.length || await o.notify(parts.join('\n\n'))
      if (sent) writeFileSync(DAILY, today, { mode: 0o600 })
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
