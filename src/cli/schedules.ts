#!/usr/bin/env node
import { DIR, placeNamer } from './home.ts'
import { outputFlags, printJson } from './output.ts'
import { whenLabel } from '../core/board.ts'
import { REPLY, cadence, nextRun, promptPreview } from '../core/cron.ts'
import { triggerLine } from '../core/tripwire.ts'
import { missingToolsIn, schedulesIn } from '../runtime/store.ts'

const out = outputFlags(process.argv.slice(2))
const place = placeNamer()
const missing = missingToolsIn(`${DIR}/kage.db`)
const day = (t: number) => new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
const rows = schedulesIn(`${DIR}/kage.db`).map(s => {
  const next = s.cron === REPLY ? undefined : nextRun(s.cron, new Date(), 8 * 24 * 3600_000)
  const when = s.cron === REPLY
    ? `${cadence(s.cron)}, until ${s.ends ? day(s.ends) : 'cancelled'}`
    : `${cadence(s.cron)}${s.recurring ? '' : ', once'}${next ? `, next ${whenLabel(next.getTime(), Date.now())}` : ''}`
  return { id: s.id, place: place(s.key), key: s.key, fromOwner: s.fromOwner, recurring: s.recurring, when, next: next?.toISOString() ?? null, model: s.model ?? null, trigger: s.trigger ? triggerLine(s.trigger) : null, blocked: missing.get(s.id) ?? [], prompt: promptPreview(s.prompt) }
})
if (out.json) { printJson(rows, out.jq); process.exit(0) }
if (!rows.length) { console.log('No schedules or watches.'); process.exit(0) }
const width = process.stdout.columns || 80
const fit = (line: string) => (line.length > width ? `${line.slice(0, width - 1)}…` : line)
for (const r of rows) {
  console.log(fit(`${r.id}  ${r.place}${r.fromOwner ? '' : ' (teammate)'}  ${r.when}${r.model ? `, on ${r.model}` : ''}`))
  if (r.trigger) console.log(fit(`    ${r.trigger}`))
  if (r.blocked.length) console.log(fit(`    blocked: ${r.blocked.join(', ')}`))
  console.log(fit(`    ${r.prompt}`))
}
