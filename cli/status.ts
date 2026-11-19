#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { DIR } from './home.ts'
import { statusSummary } from '../core/board.ts'
import { spendSince } from '../core/ledgers.ts'
import { openLedgers } from '../runtime/ledger.ts'
import { schedulesIn } from '../runtime/store.ts'
import { voice } from './voice.ts'
import { kageletRows } from '../core/kagelets.ts'
import { tailLine } from '../core/kagelet-view.ts'
import { MARK } from '../core/voice.ts'
import { kageletsDir, readKagelets } from '../runtime/kagelet-files.ts'

const read = (f: string) => { try { return readFileSync(`${DIR}/${f}`, 'utf8') } catch { return '' } }
const now = Date.now()
const runningVersion = read('version').trim()
const pid = read('status').split(/\s+/)[3]
let upSec: number | undefined
if (pid) try {
  const started = Date.parse(execFileSync('ps', ['-o', 'lstart=', '-p', pid], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim())
  if (started) upSec = Math.round((now - started) / 1000)
} catch {}
const boots24h = read('boots').split('\n').filter(l => Number(l.split(/\s/)[0]) > now / 1000 - 86_400).length
const midnight = new Date(now).setHours(0, 0, 0, 0)
const ledgers = openLedgers(DIR)
const today = spendSince(ledgers.text('costs'), midnight)
const summary = statusSummary({
  version: /^[0-9a-f]{7}/.test(runningVersion) ? runningVersion : undefined, upSec, boots24h, schedules: schedulesIn(`${DIR}/kage.db`).length,
  spentToday: today.reduce((a, r) => a + r.usd, 0), turnsToday: today.reduce((a, r) => a + r.turns, 0),
})
console.log(voice.says(summary.says))
if (summary.warn) console.log(`  ${voice.needsYou(summary.warn)} ${voice.dim('Ask')} ${voice.command('kage doctor')} ${voice.dim('why.')}`)
console.log()
spawnSync(process.execPath, [new URL('./top.ts', import.meta.url).pathname, '--once'], { stdio: 'inherit' })
const tails = kageletRows(readKagelets(kageletsDir(DIR)), { runs: ledgers.text('runs'), costs: ledgers.text('costs'), now })
if (tails.length) {
  console.log(`\nTails ${voice.dim(`${tails.filter(t => t.state === 'runs').length} of ${tails.length} out`)}`)
  for (const t of tails) {
    const { text, tone } = tailLine(t, now)
    console.log(`  ${tone === 'you' ? voice.needsYou(`${MARK.tail} ${text}`) : tone === 'quiet' ? voice.dim(`${MARK.tail} ${text}`) : `${voice.fire(MARK.tail)} ${text}`}`)
  }
}
console.log(`\n${voice.dim('Watch me live:')} ${voice.command('kage top')}  ${voice.dim('Spend:')} ${voice.command('kage cost 7')}  ${voice.dim('Problems:')} ${voice.command('kage doctor')}`)
