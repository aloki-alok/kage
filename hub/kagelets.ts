import type { Delivery } from '../core/sessions.ts'
import type { Task } from '../core/task.ts'
import { askable } from '../core/kagelets/people.ts'
import { addAllow, budgetLeft, COST_FLAG, costFlags, kageletRows, parseKagelet, type Kagelet } from '../core/kagelets/kagelet.ts'
import { heldCommand } from '../core/held.ts'
import { chainCap, dailyCap, totalCap } from '../core/kagelets/view.ts'
import type { Config } from '../core/config.ts'
import { log } from '../runtime/log.ts'
import { costCap } from '../runtime/kagelets/cost-cap.ts'
import { kageletsDir, migrateKagelets, readKagelets, writeJob } from '../runtime/kagelets/files.ts'
import { kageletManager } from '../runtime/kagelets/manager.ts'
import { kageletMemory } from '../runtime/kagelets/memory.ts'
import { kageletDeliver, NOTE_CAP, ownerNotes } from '../runtime/kagelets/notes.ts'
import { kageletMeasures } from '../runtime/kagelets/measures.ts'
import { kageletNeeds } from '../runtime/kagelets/needs.ts'
import { kageletRoutes } from '../runtime/kagelets/routes.ts'
import { kageletReview } from '../runtime/kagelets/review.ts'
import { claudeOnce, emptyRoom } from '../runtime/claude-once.ts'
import { syncKagelets } from '../runtime/kagelets/sync.ts'
import type { Ledgers, runEvents } from '../runtime/ledger.ts'
import type { Store } from '../runtime/store.ts'

export function hubKagelets(o: {
  dir: string; kl: NonNullable<Config['kagelets']>; mem: { own: string; owner: string }
  store: Store; ledgers: Ledgers; runs: ReturnType<typeof runEvents>; title: string; notify: (text: string) => void
  hasSdk: () => boolean
  runNow: (id: string, now: number) => string | undefined
  toSession: (key: string, task: Task) => Delivery
  idle: (key: string) => boolean; paused: (now: number) => number | undefined
  openHome?: (owners: string[], name: string) => Promise<string>
  tripwires: () => Config['tripwires']
}) {
  const { kl, store, ledgers } = o
  const KAGELETS = kageletsDir(o.dir)
  let grants = new Map<string, string[]>()
  let models = new Map<string, string>()
  let allows = new Map<string, string[]>()
  let refused = false
  const kmem = kageletMemory({ dir: KAGELETS, forbid: () => [o.mem.own, o.mem.owner], event: e => ledgers.event(e), waiting: cells => ledgers.add('waiting', cells) })
  const MAX = kl.max || 10
  const CAPS = { each: dailyCap(kl), total: totalCap(kl), chain: chainCap(kl) }
  const sync = (now: number) => {
    migrateKagelets(KAGELETS)
    let files = readKagelets(KAGELETS)
    if (!o.hasSdk() && files.length) { if (!refused) log('kagelets need the Agent SDK runner (harness.runtime is not tmux), so none runs'); refused = true; files = [] }
    const ran = ledgers.text('runs'), costs = ledgers.text('costs')
    const rows = kageletRows(files, { runs: ran, costs, now })
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
    allows = new Map(files.map(f => parseKagelet(f.name, f.text)).flatMap(k => 'allow' in k && k.allow && grants.has(k.key) ? [[k.key, k.allow] as const] : []))
  }
  const parsed = () => readKagelets(KAGELETS).map(f => parseKagelet(f.name, f.text)).filter((k): k is Kagelet => !('error' in k))
  const measures = kageletMeasures({ store, tripwires: () => o.tripwires() ?? {}, settings: () => ({ measureMinutes: kl.measureMinutes || 60, trendRuns: kl.trendRuns || 5 }),
    event: (who, detail) => ledgers.event({ kind: 'objective', who, trace: '', chain: '', detail }) })
  const reviewHeld = kageletReview({
    settings: () => ({ release: kl.release ?? 'rules', perDay: kl.reviewsPerDay || 10, model: kl.reviewModel || 'haiku' }),
    kagelet: key => parsed().find(k => k.key === key),
    ask: a => claudeOnce({ ...a, cwd: emptyRoom(o.dir), tools: '', timeoutMs: 30_000 }),
    event: (key, detail) => o.runs.emit(key, 'held', detail),
    today: () => new Date().toISOString().slice(0, 10),
  })
  const alwaysAllow = (key: string, tool: string, input: Record<string, unknown>) => {
    const k = tool === 'Bash' ? parsed().find(x => x.key === key) : undefined, f = k && readKagelets(KAGELETS).find(x => x.name === k.name)
    const command = String(input.command ?? ''), next = f && addAllow(f.text, command)
    if (!k || !next || next === f!.text) return
    writeJob(KAGELETS, k.name, next)
    o.runs.emit(key, 'held', `always allowed by the owner: ${heldCommand(command)}`)
  }
  const board = (key: string) => { const k = parsed().find(x => x.key === key); return k && measures.board(k.name, k.objective) }
  const manager = kageletManager({ dir: KAGELETS, max: MAX, ledgers, sync, runNow: o.runNow, store, envCommand: kl.dbRead?.command ?? undefined, log, measures, ...(kl.ownersMax !== undefined && { ownersMax: kl.ownersMax }), ...(o.openHome && { openHome: o.openHome }) })
  const notes = ownerNotes(store, () => ({ kept: kl.notesKept ?? NOTE_CAP.kept, chars: kl.noteChars ?? NOTE_CAP.chars }))
  const routes = kageletRoutes({ dir: KAGELETS, store, ledgers, runs: o.runs, deliver: kageletDeliver(notes, o.toSession, board),
    idle: o.idle, granted: key => grants.has(key), paused: o.paused, capUsd: CAPS.each, chainUsd: CAPS.chain, log, memory: name => kmem.notes(name) })
  const needs = kageletNeeds({ store, deliver: o.toSession, idle: o.idle, paused: o.paused, waiting: cells => ledgers.add('waiting', cells), perDay: () => kl.needsPerDay || 5, log })
  const tell = async (name: string, text: string, runNow: boolean, now = Date.now()): Promise<string> => {
    const lane = kageletRows(readKagelets(KAGELETS), { runs: '', costs: '', now }).find(r => r.name === name)?.key
    if (!lane || !grants.has(lane)) return `no kagelet named "${name}" runs here`
    notes.tell(lane, text)
    o.runs.emit(lane, 'owner-note', `${text.length} characters, from Kage`)
    return runNow ? `told ${name}. ${await manager.manage({ action: 'run', name }, now)}` : `told ${name}: its next run reads it`
  }
  const ask = (chat: string, thread: string, name: string, from: string, text: string, now = Date.now()): string => {
    const [k] = askable(parsed(), chat, thread, name, from)
    if (!k) return ''
    notes.asked(k.key, from, text)
    o.runs.emit(k.key, 'people-ask', `${text.length} characters`)
    if (!k.cron && k.after) return `Noted for ${name}. It runs after ${k.after}, and reads this then.`
    if (!notes.mayRun(k.key, o.idle(k.key), now, kl.askRunsPerHour ?? 4)) return `Noted for ${name}. It reads this on its next run.`
    manager.manage({ action: 'run', name }, now).catch(e => log('kagelet ask run failed', e))
    return `Asked ${name}. It answers here.`
  }
  return {
    dir: KAGELETS, kmem, manager, routes, sync, notes, needs, tell, board, measures, ask,
    peopleIn: (chat: string, thread: string) => askable(parsed(), chat, thread).map(k => ({ name: k.name, people: [...k.people ?? [], ...k.owners ?? []] })),
    measure: (now: number) => measures.tick(parsed(), now).catch(e => log('kagelet measure failed', e)),
    lanes: () => grants.keys(),
    grantOf: (key: string) => grants.get(key) ?? (key.includes('#side-kagelet-') || key.includes('#side-kdream-') ? [] : undefined),
    modelOf: (key: string) => models.get(key),
    allowOf: (key: string) => allows.get(key) ?? [],
    reviewHeld, alwaysAllow,
    budgetOf: (key: string) => key.includes('#side-kagelet-') ? budgetLeft(kageletRows(readKagelets(KAGELETS), { runs: '', costs: ledgers.text('costs'), now: Date.now() }), key, CAPS) : undefined,
  }
}
