#!/usr/bin/env node
import { memoryDirs } from '../core/guards.ts'
import { undoToSnapshot } from '../runtime/memory-snapshot.ts'
import { ENV_FILE, settings } from './home.ts'

if (process.argv[2] !== 'undo') { console.error('Usage: kage dream undo  (puts memory back as it was before the last nightly dream)'); process.exit(2) }
const own = memoryDirs(process.env.HOME!, ENV_FILE, settings().config.harness).own
const back = undoToSnapshot(own, Date.now())
console.log(back ? `Kage's memory is back to ${back}. What it held moved to ${own}/.archive/undone-*.` : `No dream snapshot in ${own}/.archive/snapshots, so nothing changed.`)
