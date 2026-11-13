// Specialists (#57): the files in the specialists folder become recurring schedules in a side lane of their thread,
// at teammate trust, and the grants the runner enforces (core/specialists.ts). The hub syncs them at start and
// each minute, so adding, changing or deleting a file applies within a minute.
import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { parseSessionKey } from '../core/conversations.ts'
import { parseSpecialist, setPaused } from '../core/specialists.ts'
import type { Store } from './store.ts'

// The folder's .md files. A missing folder is none.
export function readSpecialists(dir: string) {
  let names: string[] = []
  try { names = readdirSync(dir).filter(f => f.endsWith('.md')) } catch {}
  return names.map(f => ({ name: f.slice(0, -3), text: readFileSync(`${dir}/${f}`, 'utf8') }))
}

// kage stop <name>, the p key in kage top and the manager's tool: rewrite the paused line, keep the file.
// The hub's next sync (within a minute) applies it. Returns the line for a person.
export function pauseSpecialist(dir: string, name: string, paused: boolean): string {
  const file = `${dir}/${name}.md`
  if (!/^[a-z][a-z0-9-]{0,30}$/.test(name) || !existsSync(file)) return `There is no specialist named "${name}".`
  const text = readFileSync(file, 'utf8')
  const next = setPaused(text, paused)
  if (next === text) return `${name} is already ${paused ? 'paused' : 'running'}.`
  // A copy swapped in, so the hub never reads a half-written file.
  writeFileSync(`${file}.new`, next, { mode: 0o600 })
  renameSync(`${file}.new`, file)
  return paused ? `${name} is paused within a minute. Its file stays; resume it to run it again.` : `${name} runs again within a minute, from its next scheduled time.`
}

const said = new Map<string, string>()   // file name -> the error last logged, so a wrong file is logged once

// Returns the grants: lane key -> its tools.
export function syncSpecialists(files: { name: string; text: string }[], store: Pick<Store, 'schedules' | 'addSchedule' | 'removeSchedule' | 'seen'>, now: number, log: (line: string) => void) {
  const grants = new Map<string, string[]>()
  const ids = new Set<string>()
  for (const f of files) {
    const sp = parseSpecialist(f.name, f.text)
    if ('error' in sp) {
      if (said.get(f.name) !== sp.error) log(`specialist ${f.name} does not run: ${sp.error}`)
      said.set(f.name, sp.error)
      continue
    }
    said.delete(f.name)
    const id = `spec-${sp.name}`
    // Paused: no schedule, but a turn still running keeps its grant.
    grants.set(sp.key, sp.tools)
    if (sp.paused) continue
    ids.add(id)
    const prompt = `You are the specialist "${sp.name}", run by Kage, its manager. You approve nothing: when the job needs a decision or a tool you do not have, say so in this thread, and the manager or its owner decides. Post what you find in this thread with the reply tool.\n\n${sp.job}`
    const cur = store.schedules().find(s => s.id === id)
    if (cur && cur.key === sp.key && cur.cron === sp.cron && cur.prompt === prompt) continue
    if (cur) store.removeSchedule(id)
    store.seen(sp.key, parseSessionKey(sp.key)!.conversation, `${sp.name} (specialist)`, now)
    store.addSchedule({ id, key: sp.key, cron: sp.cron, prompt, recurring: true, fromOwner: false, created: cur?.created ?? now, lastFired: cur?.lastFired ?? 0 })
  }
  // A removed specialist goes with every schedule in its lane, the ones it added itself too.
  for (const s of store.schedules()) if ((s.id.startsWith('spec-') && !ids.has(s.id)) || (s.key.includes('#side-spec-') && !grants.has(s.key))) store.removeSchedule(s.id)
  return grants
}
