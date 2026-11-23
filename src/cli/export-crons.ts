#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { CWD, DIR } from './home.ts'
import { DatabaseSync } from 'node:sqlite'
import { cronJobsFromTranscript } from '../core/cron.ts'
import { senderFile } from '../core/guards.ts'
import { claudeProject, paneProcessStart } from '../runtime/tmux-panes.ts'

const NAME = process.env.KAGE_NAME || 'kage'
const PROJECT = claudeProject(CWD)

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
  let sender = ''
  try { sender = readFileSync(senderFile(DIR, key), 'utf8').trim() } catch {}
  for (const j of cronJobsFromTranscript(lines, paneProcessStart(pane))) {
    jobs.push({ ...j, key, fromOwner: sender === 'owner' })
    console.log(`${key}  ${j.id}  ${j.cron}${j.recurring ? '' : ' (once)'}  ${j.prompt.split('\n')[0]!.slice(0, 80)}`)
  }
}
if (process.argv.includes('--dry')) { console.log(`${jobs.length} live jobs (dry run, nothing written)`); process.exit(0) }
writeFileSync(`${DIR}/crons-import.json.tmp`, JSON.stringify({ ranUntil, jobs }, null, 2), { mode: 0o600 })
renameSync(`${DIR}/crons-import.json.tmp`, `${DIR}/crons-import.json`)
console.log(`${jobs.length} live jobs written to ${DIR}/crons-import.json. Stop the panes now; the hub adopts them on start.`)
