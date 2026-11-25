#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs'
import { DIR } from './home.ts'
import { costRows } from '../core/ledgers.ts'
import { statsData, statsLines } from '../core/stats.ts'
import { outputFlags, printJson } from './output.ts'
import { openLedgers } from '../runtime/ledger.ts'

const out = outputFlags(process.argv.slice(2))
const days = Number(out.args[0] ?? 7)
if (!(Number.isInteger(days) && days > 0 && days <= 30)) { console.error('kage stats takes a number of days from 1 to 30, like kage stats 7'); process.exit(1) }
if (!existsSync(`${DIR}/kage.db`)) { console.error(`No ${DIR}/kage.db yet: start Kage first.`); process.exit(1) }
const now = Date.now()
const l = openLedgers(DIR)
const events = Array.from({ length: days + 1 }, (_, i) => new Date(now - i * 86_400_000).toISOString().slice(0, 10)).flatMap(d => l.events(d))
let boots: number[] = []
try { boots = readFileSync(`${DIR}/boots`, 'utf8').split('\n').map(x => Number(x.split(/\s/)[0]) * 1000).filter(t => t > 0) } catch {}
const input = { costs: costRows(l.text('costs')), events, boots, days, now, reports: l.text('issue-reports') }
if (out.json) printJson(statsData(input), out.jq)
else for (const line of statsLines(input)) console.log(line)
