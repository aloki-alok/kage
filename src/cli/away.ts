#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { askHub, DIR, notRunning } from './home.ts'

const USAGE = 'Usage: kage away on [--until HH:MM] [a note], or kage away off'
const [mode = '', ...rest] = process.argv.slice(2)
if (mode !== 'on' && mode !== 'off') { console.error(USAGE); process.exit(2) }
const at = rest.indexOf('--until')
if (at >= 0 && !rest[at + 1]) { console.error(USAGE); process.exit(2) }
if (mode === 'off' && rest.length) { console.error(USAGE); process.exit(2) }
if (process.env.KAGE_CLAUDE) { console.error('This shell runs inside Kage: a session uses its own away and back tools. The owner runs kage away in their own terminal.'); process.exit(1) }
if (!existsSync(`${DIR}/router.sock`)) notRunning()
const until = at >= 0 ? rest[at + 1] : undefined
const note = rest.filter((_, i) => at < 0 || (i !== at && i !== at + 1)).join(' ')
const question = mode === 'off' ? { type: 'away', back: true } : { type: 'away', ...until && { until }, ...note && { note } }
type Answer = { text?: string; refused?: string }
const r: Answer = await askHub<Answer>(question).catch((e: Error) => e.message === 'down' ? notRunning() : { refused: 'Kage did not answer' })
if (typeof r.text !== 'string') { console.error(`Not changed: ${r.refused}.`); process.exit(1) }
console.log(r.text)
