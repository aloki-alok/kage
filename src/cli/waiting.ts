#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { openWaiting } from '../core/ledgers.ts'
import { openLedgers } from '../runtime/ledger.ts'
import { DIR, placeNamer } from './home.ts'
import { outputFlags, printJson } from './output.ts'

const out = outputFlags(process.argv.slice(2))
if (out.args.length) { console.error('Usage: kage waiting list [--json]'); process.exit(2) }
const tsv = existsSync(`${DIR}/kage.db`) ? openLedgers(DIR).text('waiting') : ''
const place = placeNamer()
const rows = openWaiting(tsv).sort((a, b) => b.when.localeCompare(a.when)).map(w => ({ when: w.when, place: place(w.thread), thread: w.thread, what: w.what, link: w.link }))
if (out.json) printJson(rows, out.jq)
else if (!rows.length) console.log('Nothing is waiting on you.')
else for (const r of rows) console.log(`${r.when.slice(0, 16).replace('T', ' ')}  ${r.place}  ${r.what}  ${r.link}`)
