import { capCheck, type Caps, type KageletRow } from '../../core/kagelets/kagelet.ts'
import type { Store } from '../store.ts'
import { pauseKagelet } from './files.ts'

const SENT = 'kagelet-cap-sent'
export function costCap(o: { dir: string; store: Pick<Store, 'load' | 'save'>; title: string; flag: (name: string, why: string) => void; tell: (text: string) => void }, rows: KageletRow[], caps: Caps, now: number): string[] {
  const day = new Date(now).toDateString()
  const was = o.store.load(SENT) as { day: string; ids: string[] } | undefined
  const sent = was?.day === day ? was.ids : []
  const r = capCheck(rows, caps, sent, o.title)
  for (const p of r.pause) { pauseKagelet(o.dir, p.name, true); o.flag(p.name, p.why) }
  for (const t of r.tell) o.tell(t.text)
  const ids = r.tell.flatMap(t => t.id ? [t.id] : [])
  if (ids.length) o.store.save(SENT, { day, ids: [...sent, ...ids] })
  return r.pause.map(p => p.name)
}
