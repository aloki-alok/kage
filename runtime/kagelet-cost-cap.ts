// The kagelet cost caps on the hub's job loop.
import { capCheck, type Caps, type KageletRow } from '../core/kagelets.ts'
import type { Store } from './store.ts'
import { pauseKagelet } from './kagelet-files.ts'

// The cost caps (core/kagelets.ts capCheck), on the hub's job loop: a kagelet over a cap is paused (its file says
// so) and flagged, and the owner gets the DMs. It stays paused past midnight: a resume is the owner's or the
// manager's call. The ids of today's once-a-day DMs are kept in the store, so a restart sends none twice.
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
