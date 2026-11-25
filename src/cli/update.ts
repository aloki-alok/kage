#!/usr/bin/env node
import { existsSync } from 'node:fs'
import type { Updated } from '../runtime/self-update.ts'
import { askHub, DIR, notRunning } from './home.ts'

if (!existsSync(`${DIR}/router.sock`)) notRunning()
const r = await askHub<Updated>({ type: 'update', stable: process.argv[2] === '--stable' }, 90_000).catch(e => ({ refused: `Kage did not answer: ${e.message}` }))
if ('refused' in r) { console.error(r.refused.charAt(0).toUpperCase() + r.refused.slice(1)); process.exit(1) }
if ('current' in r) console.log('current')
else console.log(`moved ${r.moved.old} ${r.moved.new} ${r.moved.packages ? 1 : 0}\n${r.moved.subjects.join('\n')}`)
