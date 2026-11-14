#!/usr/bin/env node
// Undo the last dream: Kage's memory goes back to the copy the hub saved before it (runtime/memory-snapshot.ts).
//   kage dream undo
import { memoryDirs } from '../core/guards.ts'
import { undoToSnapshot } from '../runtime/memory-snapshot.ts'
import { ENV_FILE, settingsEnv } from './home.ts'

if (process.argv[2] !== 'undo') { console.error('Usage: kage dream undo  (puts memory back as it was before the last nightly dream)'); process.exit(2) }
const own = memoryDirs(process.env.HOME!, ENV_FILE, { KAGE_MEMORY: settingsEnv().KAGE_MEMORY }).own
const back = undoToSnapshot(own, Date.now())
console.log(back ? `Kage's memory is back to ${back}. What it held moved to ${own}/.archive/undone-*.` : `No dream snapshot in ${own}/.archive/snapshots, so nothing changed.`)
