#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { DIR } from './home.ts'
import { statusSummary } from '../core/board.ts'
import { spendSince } from '../core/ledgers.ts'
import { openLedgers } from '../runtime/ledger.ts'
import { schedulesIn } from '../runtime/store.ts'

const read = (f: string) => { try { return readFileSync(`${DIR}/${f}`, 'utf8') } catch { return '' } }
const now = Date.now()
const pid = read('status').split(/\s+/)[3]
let upSec: number | undefined
try {
  const started = Date.parse(execFileSync('ps', ['-o', 'lstart=', '-p', pid!], { encoding: 'utf8' }).trim())
  if (started) upSec = Math.round((now - started) / 1000)
} catch {}
const boots24h = read('boots').split('\n').filter(l => Number(l.split(/\s/)[0]) > now / 1000 - 86_400).length
const midnight = new Date(now).setHours(0, 0, 0, 0)
const today = spendSince(openLedgers(DIR).text('costs'), midnight)
const lines = statusSummary({
  upSec, boots24h, schedules: schedulesIn(`${DIR}/kage.db`).length,
  spentToday: today.reduce((a, r) => a + r.usd, 0), turnsToday: today.reduce((a, r) => a + r.turns, 0),
})
console.log(lines[0])
spawnSync(process.execPath, [new URL('./top.ts', import.meta.url).pathname, '--once'], { stdio: 'inherit' })
console.log(`\n${lines[1]}`)
