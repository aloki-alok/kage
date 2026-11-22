#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { askHub, DIR } from './home.ts'
import { statusSummary } from '../core/board.ts'
import { startsSince } from '../core/boots.ts'
import { spendSince } from '../core/ledgers.ts'
import { openLedgers } from '../runtime/ledger.ts'
import { schedulesIn } from '../runtime/store.ts'
import { voice } from './voice.ts'
import { kageletRows } from '../core/kagelets/kagelet.ts'
import { kageletLine } from '../core/kagelets/view.ts'
import { MARK } from '../core/voice.ts'
import { kageletsDir, readKagelets } from '../runtime/kagelets/files.ts'

const read = (f: string) => { try { return readFileSync(`${DIR}/${f}`, 'utf8') } catch { return '' } }
const now = Date.now()
const runningVersion = read('version').trim()
const pid = read('status').split(/\s+/)[3]
let upSec: number | undefined
if (pid) try {
  const started = Date.parse(execFileSync('ps', ['-o', 'lstart=', '-p', pid], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim())
  if (started) upSec = Math.round((now - started) / 1000)
} catch {}
const starts = startsSince(read('boots'), now / 1000 - 86_400)
const midnight = new Date(now).setHours(0, 0, 0, 0)
const ledgers = openLedgers(DIR)
const today = spendSince(ledgers.text('costs'), midnight)
const summary = statusSummary({
  version: /^[0-9a-f]{7}/.test(runningVersion) ? runningVersion : undefined, upSec, starts, schedules: schedulesIn(`${DIR}/kage.db`).length,
  spentToday: today.reduce((a, r) => a + r.usd, 0), turnsToday: today.reduce((a, r) => a + r.turns, 0),
})
console.log(voice.says(summary.says))
if (summary.warn) console.log(`  ${voice.needsYou(summary.warn)} ${voice.dim('Ask')} ${voice.command('kage doctor')} ${voice.dim('why.')}`)
const health = await askHub<{ lines?: string[] }>({ type: 'health' }).then(a => a.lines ?? [], () => [])
if (health.length) {
  console.log(`\nConnectors`)
  for (const l of health) console.log(`  ${/ off$/.test(l) ? voice.dim(l) : / failed \d+x /.test(l) ? voice.needsYou(l) : l}`)
}
console.log()
spawnSync(process.execPath, [new URL('./top.ts', import.meta.url).pathname, '--once'], { stdio: 'inherit' })
const kagelets = kageletRows(readKagelets(kageletsDir(DIR)), { runs: ledgers.text('runs'), costs: ledgers.text('costs'), now })
if (kagelets.length) {
  console.log(`\nKagelets ${voice.dim(`${kagelets.filter(k => k.state === 'runs').length} of ${kagelets.length} on`)}`)
  for (const k of kagelets) {
    const { text, tone } = kageletLine(k, now)
    console.log(`  ${tone === 'you' ? voice.needsYou(text) : tone === 'quiet' ? voice.dim(`${MARK.quiet} ${text}`) : `${voice.work(MARK.working)} ${text}`}`)
  }
}
console.log(`\n${voice.dim('Watch me live:')} ${voice.command('kage top')}  ${voice.dim('Spend:')} ${voice.command('kage cost 7')}  ${voice.dim('Problems:')} ${voice.command('kage doctor')}`)
