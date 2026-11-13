// Specialists (#57): the files in the specialists folder become recurring schedules in a side lane of their thread,
// at teammate trust, and the grants the runner enforces (core/specialists.ts). The hub syncs them at start and
// each minute, so adding, changing or deleting a file applies within a minute.
import { parseSessionKey } from '../core/conversations.ts'
import { parseSpecialist } from '../core/specialists.ts'
import type { Store } from './store.ts'

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
    ids.add(id)
    grants.set(sp.key, sp.tools)
    const prompt = `You are the specialist "${sp.name}", run by Kage, its manager. You approve nothing: when the job needs a decision or a tool you do not have, say so in this thread, and the manager or its owner decides. Post what you find in this thread with the reply tool.\n\n${sp.job}`
    const cur = store.schedules().find(s => s.id === id)
    if (cur && cur.key === sp.key && cur.cron === sp.cron && cur.prompt === prompt) continue
    if (cur) store.removeSchedule(id)
    store.seen(sp.key, parseSessionKey(sp.key)!.conversation, `${sp.name} (specialist)`, now)
    store.addSchedule({ id, key: sp.key, cron: sp.cron, prompt, recurring: true, fromOwner: false, created: cur?.created ?? now, lastFired: cur?.lastFired ?? 0 })
  }
  for (const s of store.schedules()) if (s.id.startsWith('spec-') && !ids.has(s.id)) store.removeSchedule(s.id)
  return grants
}
