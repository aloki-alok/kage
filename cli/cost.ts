#!/usr/bin/env node
// What Kage spent per thread, from the ledger the hub writes after every turn (core/ledgers.ts).
//   kage cost [days]
import { existsSync, readFileSync } from 'node:fs'
import { DIR, placeNamer } from './home.ts'
import { spendSince } from '../core/ledgers.ts'

const days = Number(process.argv[2] ?? 1)
if (!(days > 0)) { console.error('kage cost takes a number of days, like kage cost 7'); process.exit(1) }
const tsv = existsSync(`${DIR}/costs.tsv`) ? readFileSync(`${DIR}/costs.tsv`, 'utf8') : ''
const rows = spendSince(tsv, Date.now() - days * 24 * 3600_000)
if (!rows.length) { console.log(`No turns in the last ${days} day${days === 1 ? '' : 's'}. The hub adds a line to ${DIR}/costs.tsv after each SDK turn.`); process.exit(0) }
const place = placeNamer()
const total = rows.reduce((a, r) => a + r.usd, 0)
const turns = rows.reduce((a, r) => a + r.turns, 0)
console.log(`$${total.toFixed(2)} over ${turns} turns in the last ${days} day${days === 1 ? '' : 's'} (an estimate from the Agent SDK, not a bill)\n`)
for (const r of rows.slice(0, 20)) console.log(`${('$' + r.usd.toFixed(2)).padStart(8)}  ${String(r.turns).padStart(4)} turns  ${place(r.key)}`)
if (rows.length > 20) console.log(`  ... ${rows.length - 20} more threads`)
