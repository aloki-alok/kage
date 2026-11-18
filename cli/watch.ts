#!/usr/bin/env node
import { existsSync, statSync } from 'node:fs'
import { CWD, DIR } from './home.ts'
import { DatabaseSync } from 'node:sqlite'
import { stepTime, transcriptLine } from '../core/transcript.ts'
import { newLines } from '../runtime/transcript-tail.ts'

const HOME = process.env.HOME!
const PROJECT = `${HOME}/.claude/projects/${CWD.replace(/[^A-Za-z0-9]/g, '-')}`
const args = process.argv.slice(2)
const only = args.find(a => !a.startsWith('--'))?.toLowerCase()
const HUB_LOG = args.includes('--hub') ? `${DIR}/hub.log` : undefined
if (!existsSync(`${DIR}/kage.db`)) { console.error(`No ${DIR}/kage.db yet: start Kage first.`); process.exit(1) }
const db = new DatabaseSync(`${DIR}/kage.db`, { readOnly: true })
const threads = db.prepare('select s.key, s.claude_id as id, coalesce(c.place, s.key) as place from sessions s left join conversations c using (key)')

const RECENT = 30 * 60_000
const offsets = new Map<string, number>()
const time = (t = Date.now()) => new Date(t).toTimeString().slice(0, 8)
const tty = process.stdout.isTTY
const paint = (rgb: string, s: string) => (tty ? `\x1b[38;2;${rgb}m${s}\x1b[0m` : s)
const RED = '229;70;46', MUTED = '163;158;148', INK = '244;241;234'
const COLOR: Record<string, string> = { reply: RED, error: RED, task: INK, input: INK }
let lastPlace = ''
function print(at: number, place: string, step: string) {
  const label = step.slice(0, 5).trim()
  if (place !== lastPlace) console.log(`\n${paint(RED, '▍')} ${paint(INK, place)}`)
  lastPlace = place
  console.log(`  ${paint(MUTED, time(at))}  ${paint(COLOR[label] ?? MUTED, step.slice(0, 5))} ${step.slice(6)}`)
}

if (!existsSync(PROJECT)) console.error(`No transcripts in ${PROJECT}. If the hub runs in another folder, set harness.cwd to it (kage set harness.cwd <folder>).`)

function hubLines(first: boolean) {
  if (!HUB_LOG) return
  if (!offsets.has(HUB_LOG)) { let size = 0; try { size = statSync(HUB_LOG).size } catch {} ; offsets.set(HUB_LOG, first ? Math.max(0, size - 4_000) : 0) }
  const r = newLines(HUB_LOG, offsets.get(HUB_LOG)!)
  offsets.set(HUB_LOG, r.offset)
  for (const raw of first ? r.lines.slice(-20) : r.lines) {
    const m = /^(\S+Z) (?:\[kage\] )?(.*)$/.exec(raw)
    print(m ? Date.parse(m[1]!) || Date.now() : Date.now(), 'hub', `hub   ${m ? m[2] : raw}`)
  }
}

function scan(first: boolean) {
  hubLines(first)
  let all: { id: string; place: string }[]
  try { all = threads.all() as typeof all } catch { return }
  for (const t of all) {
    if (only && !t.place.toLowerCase().includes(only)) continue
    const file = `${PROJECT}/${t.id}.jsonl`
    if (!offsets.has(file)) {
      let size = 0, mtime = 0
      try { ({ size, mtimeMs: mtime } = statSync(file)) } catch {}
      offsets.set(file, !first ? 0 : Date.now() - mtime < RECENT ? Math.max(0, size - 64_000) : size)
    }
    const r = newLines(file, offsets.get(file)!)
    offsets.set(file, r.offset)
    let steps = r.lines.flatMap(raw => {
      const at = stepTime(raw) ?? Date.now()
      return (transcriptLine(raw)?.split('\n') ?? []).map(s => ({ at, s }))
    })
    if (first) steps = steps.slice(-5)
    for (const { at, s } of steps) print(at, t.place, s)
  }
}

scan(true)
console.log(`--- following ${only ? `threads matching "${only}"` : 'every thread'} (Ctrl-c to stop)`)
setInterval(() => scan(false), 1000)
