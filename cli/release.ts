#!/usr/bin/env node
// kage release [--dry-run]: tag the next version on main, publish its notes, and move `stable` to it (ADR 0013).
// --dry-run prints the version, the notes and every problem, and changes nothing.
import { release } from '../runtime/release.ts'

const dry = process.argv.includes('--dry-run')
const root = new URL('..', import.meta.url).pathname
const r = await release(root, dry)
if (r.version) console.log(`${dry ? 'Would release' : 'Released'} v${r.version}\n\n${r.notes}\n`)
for (const p of r.problems) console.log(`${dry ? 'Would refuse' : 'Refused'}: ${p}`)
if (r.url) console.log(r.url)
process.exit(r.problems.length && !dry ? 1 : 0)
