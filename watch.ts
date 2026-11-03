#!/usr/bin/env node
// kage watch: follow every thread's session from a terminal, one line per step: the task, what
// Kage does, what it replies. Reads the hub's store and the Claude Code transcripts, so it works
// with both runtimes (tmux panes and SDK sessions) and never touches a running session.
//   ./setup.sh watch [place]     only threads whose place contains [place], e.g. "acme"
import { existsSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { newLines, transcriptLine } from './core/transcript.ts'

const HOME = process.env.HOME!
const DIR = dirname(process.env.KAGE_ENV || `${HOME}/.config/kage/env`)
// Sessions run in the hub's working folder (start.sh: KAGE_CWD, else home); Claude Code names the
// transcript folder after it.
const PROJECT = `${HOME}/.claude/projects/${(process.env.KAGE_CWD || HOME).replace(/[^A-Za-z0-9]/g, '-')}`
const only = process.argv[2]?.toLowerCase()
if (!existsSync(`${DIR}/kage.db`)) { console.error(`No ${DIR}/kage.db yet: start Kage first.`); process.exit(1) }
const db = new DatabaseSync(`${DIR}/kage.db`, { readOnly: true })
const threads = db.prepare('select s.key, s.claude_id as id, coalesce(c.place, s.key) as place from sessions s left join conversations c using (key)')

const RECENT = 30 * 60_000   // on start, show the last steps of threads active in the last 30 min
const offsets = new Map<string, number>()
const time = () => new Date().toTimeString().slice(0, 8)

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
    let steps = r.lines.map(transcriptLine).filter(Boolean).flatMap(s => s!.split('\n'))
    if (first) steps = steps.slice(-5)
    for (const s of steps) console.log(`${time()}  ${t.place.slice(0, 24).padEnd(24)}  ${s}`)
  }
}

scan(true)
console.log(`--- following ${only ? `threads matching "${only}"` : 'every thread'} (Ctrl-c to stop)`)
setInterval(() => scan(false), 1000)
