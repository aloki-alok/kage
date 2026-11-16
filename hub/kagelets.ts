// Kagelets (#57) in the hub: one file each in the kagelets folder, synced at start and each minute. Each runs on its
// schedule in a side lane of its thread, at teammate trust, with only its grant, and approves nothing. Also each
// kagelet's memory (#98), the manager's side for Kage's owner sessions, the owner's notes to a kagelet, and the
// chains and messages between kagelets (#93), which the hub hands on with no Kage turn.
import type { Delivery } from '../core/sessions.ts'
import type { Task } from '../core/task.ts'
import { budgetLeft, COST_FLAG, costFlags, kageletRows } from '../core/kagelets.ts'
import { chainCap, dailyCap, totalCap } from '../core/kagelet-view.ts'
import type { Config } from '../core/config.ts'
import { log } from '../runtime/log.ts'
import { costCap } from '../runtime/kagelet-cost-cap.ts'
import { kageletsDir, migrateKagelets, readKagelets } from '../runtime/kagelet-files.ts'
import { kageletManager } from '../runtime/kagelet-manager.ts'
import { kageletMemory } from '../runtime/kagelet-memory.ts'
import { ownerNotes } from '../runtime/kagelet-notes.ts'
import { kageletRoutes } from '../runtime/kagelet-routes.ts'
import { syncKagelets } from '../runtime/kagelet-sync.ts'
import type { Ledgers, runEvents } from '../runtime/ledger.ts'
import type { Store } from '../runtime/store.ts'

export function hubKagelets(o: {
  dir: string; kl: NonNullable<Config['kagelets']>; mem: { own: string; owner: string }
  store: Store; ledgers: Ledgers; runs: ReturnType<typeof runEvents>; title: string; notify: (text: string) => void
  hasSdk: () => boolean   // only the SDK runner enforces a grant, so with tmux panes no kagelet runs
  runNow: (id: string, now: number) => string | undefined
  toSession: (key: string, task: Task) => Delivery
  idle: (key: string) => boolean; paused: (now: number) => number | undefined
}) {
  const { kl, store, ledgers } = o
  const KAGELETS = kageletsDir(o.dir)
  let grants = new Map<string, string[]>()
  let models = new Map<string, string>()   // lane key -> the model its file names
  let refused = false
  // Each kagelet's own memory and the dream's proposals waiting on Kage. It never reads or writes the owner's or Kage's memory.
  const kmem = kageletMemory({ dir: KAGELETS, forbid: () => [o.mem.own, o.mem.owner], event: e => ledgers.event(e), waiting: cells => ledgers.add('waiting', cells) })
  const MAX = kl.max || 10
  // Off unless set (#96); a value that does not read as dollars is said once, here.
  const CAPS = { each: dailyCap(kl), total: totalCap(kl), chain: chainCap(kl) }
  // With tmux panes their schedules are removed. A kagelet over its daily cost cap is paused and flagged first, so this sync already drops its schedule.
  const sync = (now: number) => {
    migrateKagelets(KAGELETS)
    let files = readKagelets(KAGELETS)
    if (!o.hasSdk() && files.length) { if (!refused) log('kagelets need the Agent SDK runner (harness.runtime is not tmux), so none runs'); refused = true; files = [] }
    const ran = ledgers.text('runs'), costs = ledgers.text('costs')
    const rows = kageletRows(files, { runs: ran, costs, now })
    // Cost monitoring (#96): one line per kagelet a day in the reports ledger, where Kage reads it, and the event log. No DM.
    for (const f of costFlags(rows, { runs: ran, costs, reports: ledgers.text('reports') }, now)) { ledgers.add('reports', [`${COST_FLAG}${f.name}`, f.line, '']); log(`kagelet cost flag: ${f.line}`) }
    if (costCap({ dir: KAGELETS, store, title: o.title, tell: o.notify, flag: (name, why) => {
      const r = rows.find(x => x.name === name)!
      ledgers.add('reports', [name, why, 'the owner to resume it, or a higher cap'])
      o.runs.emit(r.key!, 'cap-pause', why)
      ledgers.add('waiting', ['open', r.key!.split('#')[0]!, r.link ?? '', `kagelet ${name} ${why}`])
      log(`kagelet ${name} ${why}`)
    } }, rows, CAPS, now).length) files = readKagelets(KAGELETS)
    grants = syncKagelets(files, store, now, log, MAX, name => kmem.notes(name))
    models = new Map(rows.filter(r => r.key && r.model && grants.has(r.key)).map(r => [r.key!, r.model!]))
  }
  const manager = kageletManager({ dir: KAGELETS, max: MAX, ledgers, sync, runNow: o.runNow, store, envCommand: kl.dbRead?.command ?? undefined, log })
  const routes = kageletRoutes({ dir: KAGELETS, store, ledgers, runs: o.runs, deliver: o.toSession,
    idle: o.idle, paused: o.paused, capUsd: CAPS.each, chainUsd: CAPS.chain, log, memory: name => kmem.notes(name) })
  return {
    dir: KAGELETS, kmem, manager, routes, sync, notes: ownerNotes(store),
    lanes: () => grants.keys(),
    // A lane whose file is gone keeps no tools, rather than falling back to approval cards.
    grantOf: (key: string) => grants.get(key) ?? (key.includes('#side-kagelet-') || key.includes('#side-kdream-') ? [] : undefined),
    modelOf: (key: string) => models.get(key),
    budgetOf: (key: string) => key.includes('#side-kagelet-') ? budgetLeft(kageletRows(readKagelets(KAGELETS), { runs: '', costs: ledgers.text('costs'), now: Date.now() }), key, CAPS) : undefined,
  }
}
