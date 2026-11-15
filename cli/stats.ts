#!/usr/bin/env node
// What Kage did and spent, day by day (core/stats.ts decides the lines).
//   kage stats [days]   (default 7)
import { readFileSync } from 'node:fs'
import { DIR } from './home.ts'
import { costRows } from '../core/ledgers.ts'
import { statsLines } from '../core/stats.ts'
import { openLedgers } from '../runtime/ledger.ts'

const days = Number(process.argv[2] ?? 7)
if (!(Number.isInteger(days) && days > 0 && days <= 30)) { console.error('kage stats takes a number of days from 1 to 30, like kage stats 7'); process.exit(1) }
const now = Date.now()
const l = openLedgers(DIR)
// The event log keys rows by UTC day: read each day the window touches, one more for the time zone edge.
const events = Array.from({ length: days + 1 }, (_, i) => new Date(now - i * 86_400_000).toISOString().slice(0, 10)).flatMap(d => l.events(d))
let boots: number[] = []
try { boots = readFileSync(`${DIR}/boots`, 'utf8').split('\n').map(x => Number(x.split(/\s/)[0]) * 1000).filter(t => t > 0) } catch {}
for (const line of statsLines({ costs: costRows(l.text('costs')), events, boots, days, now })) console.log(line)
