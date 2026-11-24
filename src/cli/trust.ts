#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { trustTable } from '../core/trust.ts'
import { trustLinesIn } from '../runtime/trust-store.ts'
import { askHub, DIR, notRunning } from './home.ts'

const USAGE = 'Usage: kage trust list | revoke <id>'
const [action = '', arg = ''] = process.argv.slice(2)

if (action === 'list') {
  if (!existsSync(`${DIR}/kage.db`)) notRunning()
  console.log(trustTable(trustLinesIn(`${DIR}/kage.db`)))
} else if (action === 'revoke' && arg) {
  if (process.env.KAGE_CLAUDE) { console.error('This shell runs inside Kage: a session cannot change the trust record.'); process.exit(1) }
  if (!existsSync(`${DIR}/router.sock`)) notRunning()
  try {
    const r = await askHub<{ ok?: true; text?: string; refused?: string }>({ type: 'trust', action, id: arg })
    if (r.ok) console.error(`${r.text}.`)
    else { console.error(`Refused: ${r.refused}.`); process.exitCode = 1 }
  } catch (e) { console.error(`Kage did not answer: ${(e as Error).message}`); process.exitCode = 1 }
} else { console.error(USAGE); process.exit(1) }
