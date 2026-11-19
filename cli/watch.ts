#!/usr/bin/env node
import { existsSync, statSync } from 'node:fs'
import { CWD, DIR } from './home.ts'
import { DatabaseSync } from 'node:sqlite'
import { stepTime, transcriptSteps, type Step } from '../core/transcript.ts'
import { spokenStep } from '../core/voice.ts'
import { voice } from './voice.ts'
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
let lastPlace = ''
function print(at: number, place: string, step: Step) {
  if (place !== lastPlace) console.log(`\n${place}`)
  lastPlace = place
  const { text, tone } = spokenStep(step)
  console.log(`  ${voice.dim(time(at))}  ${tone === 'red' ? voice.red(text) : tone === 'quiet' ? voice.dim(text) : text}`)
}

if (!existsSync(PROJECT)) console.error(`No transcripts in ${PROJECT}. If the hub runs in another folder, set harness.cwd to it (kage set harness.cwd <folder>).`)

function hubLines(first: boolean) {
  if (!HUB_LOG) return
  if (!offsets.has(HUB_LOG)) { let size = 0; try { size = statSync(HUB_LOG).size } catch {} ; offsets.set(HUB_LOG, first ? Math.max(0, size - 4_000) : 0) }
  const r = newLines(HUB_LOG, offsets.get(HUB_LOG)!)
  offsets.set(HUB_LOG, r.offset)
  for (const raw of first ? r.lines.slice(-20) : r.lines) {
    const m = /^(\S+Z) (?:\[kage\] )?(.*)$/.exec(raw)
    print(m ? Date.parse(m[1]!) || Date.now() : Date.now(), 'Kage itself', { kind: 'says', text: m ? m[2]! : raw })
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
      return transcriptSteps(raw).map(step => ({ at, step }))
    })
    if (first) steps = steps.slice(-5)
    for (const { at, step } of steps) print(at, t.place, step)
  }
}

console.log(`\n${voice.says(`Here's what I'm doing${only ? ` in threads matching "${only}"` : ''}, live.`)} ${voice.dim('Ctrl-C to stop.')}`)
scan(true)
setInterval(() => scan(false), 1000)
