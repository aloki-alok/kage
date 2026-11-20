import { parseSessionKey } from '../../core/conversations.ts'
import { memoryBlock } from '../../core/kagelets/memory.ts'
import { chainErrors, parseKagelet, type Kagelet } from '../../core/kagelets/kagelet.ts'
import type { Store } from '../store.ts'

export const kageletPrompt = (sp: Pick<Kagelet, 'name' | 'job'>, notes: { file: string; text: string }[] = []) => `Run of the kagelet "${sp.name}". Its rules are in your instructions.\n\n${sp.job}${memoryBlock(notes)}`

const said = new Map<string, string>()

export function syncKagelets(files: { name: string; text: string }[], store: Pick<Store, 'schedules' | 'addSchedule' | 'removeSchedule' | 'seen' | 'conversation'>, now: number, log: (line: string) => void, max = 10, memory: (name: string) => { file: string; text: string }[] = () => []) {
  const grants = new Map<string, string[]>()
  const ids = new Set<string>()
  let running = 0
  const parsed = files.map(f => parseKagelet(f.name, f.text)).filter((p): p is Kagelet => !('error' in p))
  const broken = chainErrors(parsed)
  for (const f of [...files].sort((a, b) => a.name.localeCompare(b.name))) {
    let sp = parseKagelet(f.name, f.text)
    if (!('error' in sp) && broken.has(sp.name)) sp = { error: broken.get(sp.name)! }
    if (!('error' in sp) && !sp.paused && ++running > max) sp = { error: `this install runs at most ${max} kagelets (kagelets.max)` }
    if ('error' in sp) {
      if (said.get(f.name) !== sp.error) log(`kagelet ${f.name} does not run: ${sp.error}`)
      said.set(f.name, sp.error)
      continue
    }
    said.delete(f.name)
    const id = `kagelet-${sp.name}`
    grants.set(sp.key, sp.tools)
    if (sp.paused) continue
    if (!sp.cron) { if (!store.conversation(sp.key)) store.seen(sp.key, parseSessionKey(sp.key)!.conversation, `${sp.name} (kagelet)`, now); continue }
    ids.add(id)
    const prompt = kageletPrompt(sp, memory(sp.name))
    const cur = store.schedules().find(s => s.id === id)
    if (cur && cur.key === sp.key && cur.cron === sp.cron && cur.prompt === prompt) continue
    if (cur) store.removeSchedule(cur.id)
    store.seen(sp.key, parseSessionKey(sp.key)!.conversation, `${sp.name} (kagelet)`, now)
    store.addSchedule({ id, key: sp.key, cron: sp.cron, prompt, recurring: true, fromOwner: false, created: cur?.created ?? now, lastFired: cur?.lastFired ?? 0 })
  }
  for (const s of store.schedules()) if ((s.id.startsWith('kagelet-') && !ids.has(s.id)) || (s.key.includes('#side-kagelet-') && !grants.has(s.key))) store.removeSchedule(s.id)
  return grants
}
