#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { askHub, DIR, notRunning } from './home.ts'
import { pickThread } from './pick-thread.ts'

const [place = '', ...words] = process.argv.slice(2)
const text = words.join(' ').trim()
if (!place || !text) { console.error('Usage: kage post <dm, or a thread: its place, key or Slack link in quotes> <text>'); process.exit(2) }
if (process.env.KAGE_CLAUDE) { console.error('This shell runs inside Kage: a session posts with its own tools. The owner runs kage post in their own terminal.'); process.exit(1) }
if (!existsSync(`${DIR}/router.sock`)) notRunning()
const key = place === 'dm' ? undefined : (await pickThread(place, false)).key
const at = key && /^([A-Z0-9]+):(\d+\.\d+)$/.exec(key)
if (key && !at) { console.error(`kage post posts only in the DM with Kage or a Slack thread, and ${key} is neither.`); process.exit(1) }
type Answer = { ok?: true; channel?: string; ts?: string; refused?: string }
const r: Answer = await askHub<Answer>({ type: 'say', text, ...at && { channel: at[1], thread_ts: at[2] } })
  .catch((e: Error) => e.message === 'down' ? notRunning() : { refused: 'Kage did not answer' })
if (!r.ok) { console.error(`Not posted: ${r.refused}.`); process.exit(1) }
console.log(`Posted ${key ? `in ${place}` : 'in the DM with Kage'}.`)
