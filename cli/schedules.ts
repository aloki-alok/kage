#!/usr/bin/env node
// Every schedule and watch the hub keeps, across threads: what runs, where, and when a watch ends.
//   kage schedules
import { DIR, placeNamer } from './home.ts'
import { whenLabel } from '../core/board.ts'
import { REPLY, cadence, nextRun, promptPreview } from '../core/cron.ts'
import { schedulesIn } from '../runtime/store.ts'

const all = schedulesIn(`${DIR}/kage.db`)
if (!all.length) { console.log('No schedules or watches.'); process.exit(0) }
const place = placeNamer()
const day = (t: number) => new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
const width = process.stdout.columns || 80
const fit = (line: string) => (line.length > width ? `${line.slice(0, width - 1)}…` : line)
for (const s of all) {
  const next = s.cron === REPLY ? undefined : nextRun(s.cron, new Date(), 8 * 24 * 3600_000)
  const when = s.cron === REPLY
    ? `${cadence(s.cron)}, until ${s.ends ? day(s.ends) : 'cancelled'}`
    : `${cadence(s.cron)}${s.recurring ? '' : ', once'}${next ? `, next ${whenLabel(next.getTime(), Date.now())}` : ''}`
  console.log(fit(`${s.id}  ${place(s.key)}${s.fromOwner ? '' : ' (teammate)'}  ${when}`))
  console.log(fit(`    ${promptPreview(s.prompt)}`))
}
