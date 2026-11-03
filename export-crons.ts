#!/usr/bin/env node
// For a full restart or the switch to SDK sessions: move the CronCreate jobs still alive in the tmux
// panes into the hub's schedules, so no watcher is lost when the panes stop. Run it right before
// `tmux kill-session`; the hub adopts the file on its next start (runtime/scheduler.ts adopt).
//   ./setup.sh export-crons
import { execFileSync } from 'node:child_process'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { cronJobsFromTranscript } from './core/cron.ts'
import { senderFile } from './core/guards.ts'
import { claudeProject, paneProcessStart } from './runtime/tmux-windows.ts'

const HOME = process.env.HOME!
const DIR = dirname(process.env.KAGE_ENV || `${HOME}/.config/kage/env`)
const NAME = process.env.KAGE_NAME || 'kage'
const PROJECT = claudeProject(process.env.KAGE_CWD || HOME)

const db = new DatabaseSync(`${DIR}/kage.db`, { readOnly: true })
const keyOf = new Map((db.prepare('select key, claude_id from sessions').all() as { key: string; claude_id: string }[]).map(r => [r.claude_id, r.key]))
const panes = execFileSync('tmux', ['list-panes', '-s', '-t', `=${NAME}`, '-F', '#{@kage} #{pane_id}'], { encoding: 'utf8' })
  .split('\n').filter(l => /^\S+ %\d+$/.test(l)).map(l => l.split(' ') as [string, string])

const ranUntil = Date.now()
const jobs = []
for (const [id, pane] of panes) {
  const key = keyOf.get(id)
  if (!key) continue
  let lines: string[] = []
  try { lines = readFileSync(`${PROJECT}/${id}.jsonl`, 'utf8').split('\n') } catch { continue }
  // The pane's latest task decides the trust its jobs keep: a teammate's job stays a teammate's.
  let sender = ''
  try { sender = readFileSync(senderFile(DIR, key), 'utf8').trim() } catch {}
  for (const j of cronJobsFromTranscript(lines, paneProcessStart(pane))) {
    jobs.push({ ...j, key, fromOwner: sender === 'owner' })
    console.log(`${key}  ${j.id}  ${j.cron}${j.recurring ? '' : ' (once)'}  ${j.prompt.split('\n')[0]!.slice(0, 80)}`)
  }
}
// Written only when the panes are about to stop: a hub that adopted them while the panes still ran
// would run every job twice.
if (process.argv.includes('--dry')) { console.log(`${jobs.length} live jobs (dry run, nothing written)`); process.exit(0) }
// Written whole or not at all, so the hub never reads half a file.
writeFileSync(`${DIR}/crons-import.json.tmp`, JSON.stringify({ ranUntil, jobs }, null, 2), { mode: 0o600 })
renameSync(`${DIR}/crons-import.json.tmp`, `${DIR}/crons-import.json`)
console.log(`${jobs.length} live jobs written to ${DIR}/crons-import.json. Stop the panes now; the hub adopts them on start.`)
