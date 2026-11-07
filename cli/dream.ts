#!/usr/bin/env node
// Undo the last dream: Kage's memory goes back to the copy the hub saved before it (runtime/memory-snapshot.ts).
//   kage dream undo
import { readFileSync } from 'node:fs'
import { memoryDirs } from '../core/guards.ts'
import { undoToSnapshot } from '../runtime/memory-snapshot.ts'
import { ENV_FILE } from './home.ts'

if (process.argv[2] !== 'undo') { console.error('Usage: kage dream undo  (puts memory back as it was before the last nightly dream)'); process.exit(2) }
// KAGE_MEMORY may be set in the env file; only that line is read, never a token.
const line = readFileSync(ENV_FILE, 'utf8').split('\n').find(l => l.startsWith('KAGE_MEMORY='))
const own = memoryDirs(process.env.HOME!, ENV_FILE, { KAGE_MEMORY: line?.slice('KAGE_MEMORY='.length).trim() || undefined }).own
const back = undoToSnapshot(own, Date.now())
console.log(back ? `Kage's memory is back to ${back}. What it held moved to ${own}/.archive/undone-*.` : `No dream snapshot in ${own}/.archive/snapshots, so nothing changed.`)
