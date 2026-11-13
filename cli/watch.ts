#!/usr/bin/env node
// kage watch: follow every thread's session from a terminal, one line per step: the task, what
// Kage does, what it replies. Reads the hub's store and the Claude Code transcripts, so it works
// with both runtimes (tmux panes and SDK sessions) and never touches a running session.
//   kage watch [place]     only threads whose place contains [place], e.g. "support"
import { existsSync, statSync } from 'node:fs'
import { DIR } from './home.ts'
import { DatabaseSync } from 'node:sqlite'
import { newLines, stepTime, transcriptLine } from '../core/transcript.ts'

const HOME = process.env.HOME!
// Sessions run in the hub's working folder (run.sh: KAGE_CWD, else home); Claude Code names the
// transcript folder after it.
const PROJECT = `${HOME}/.claude/projects/${(process.env.KAGE_CWD || HOME).replace(/[^A-Za-z0-9]/g, '-')}`
const only = process.argv[2]?.toLowerCase()
if (!existsSync(`${DIR}/kage.db`)) { console.error(`No ${DIR}/kage.db yet: start Kage first.`); process.exit(1) }
const db = new DatabaseSync(`${DIR}/kage.db`, { readOnly: true })
const threads = db.prepare('select s.key, s.claude_id as id, coalesce(c.place, s.key) as place from sessions s left join conversations c using (key)')

const RECENT = 30 * 60_000   // on start, show the last steps of threads active in the last 30 min
const offsets = new Map<string, number>()
const time = (t = Date.now()) => new Date(t).toTimeString().slice(0, 8)
// Kage's palette (docs/how-it-works.svg): red for what reaches people, muted for the rest.
const tty = process.stdout.isTTY
const paint = (rgb: string, s: string) => (tty ? `\x1b[38;2;${rgb}m${s}\x1b[0m` : s)
const RED = '229;70;46', MUTED = '163;158;148', INK = '244;241;234'
const COLOR: Record<string, string> = { reply: RED, error: RED, task: INK, input: INK }
let lastPlace = ''
function print(at: number, place: string, step: string) {
  const label = step.slice(0, 5).trim()
  // A run of steps from one thread names it once: the place is a header, not a column.
  if (place !== lastPlace) console.log(`\n${paint(RED, '▍')} ${paint(INK, place)}`)
  lastPlace = place
  console.log(`  ${paint(MUTED, time(at))}  ${paint(COLOR[label] ?? MUTED, step.slice(0, 5))} ${step.slice(6)}`)
}

if (!existsSync(PROJECT)) console.error(`No transcripts in ${PROJECT}. If the hub runs in another folder, set KAGE_CWD to it.`)

function scan(first: boolean) {
  let all: { id: string; place: string }[]
  try { all = threads.all() as typeof all } catch { return }   // the store is busy: next tick
  for (const t of all) {
    if (only && !t.place.toLowerCase().includes(only)) continue
    const file = `${PROJECT}/${t.id}.jsonl`
    if (!offsets.has(file)) {
      let size = 0, mtime = 0
      try { ({ size, mtimeMs: mtime } = statSync(file)) } catch {}
      // A thread seen for the first time after start is new: show it from the top.
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
