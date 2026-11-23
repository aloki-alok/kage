import type { Delivery } from '../core/sessions.ts'
import type { Task } from '../core/task.ts'
import { askable } from '../core/kagelets/people.ts'
import { addAllow, budgetLeft, COST_FLAG, costFlags, kageletRows, parseKagelet, type Kagelet, type KageletRow } from '../core/kagelets/kagelet.ts'
import { heldCommand } from '../core/held.ts'
import { chainCap, dailyCap, totalCap } from '../core/kagelets/view.ts'
import type { Config } from '../core/config.ts'
import { log } from '../runtime/log.ts'
import { costCap } from '../runtime/kagelets/cost-cap.ts'
import { kageletsDir, migrateKagelets, pauseKagelet, readKagelets, writeJob } from '../runtime/kagelets/files.ts'
import { kageletIncidents } from '../runtime/kagelets/incidents.ts'
import { newLines } from '../runtime/transcript-tail.ts'
import { transcriptSteps } from '../core/transcript.ts'
import { kageletManager } from '../runtime/kagelets/manager.ts'
import { kageletMemory } from '../runtime/kagelets/memory.ts'
import { kageletDeliver, NOTE_CAP, ownerNotes } from '../runtime/kagelets/notes.ts'
import { kageletMeasures } from '../runtime/kagelets/measures.ts'
import { kageletNeeds } from '../runtime/kagelets/needs.ts'
import { kageletRoutes } from '../runtime/kagelets/routes.ts'
import { kageletReview } from '../runtime/kagelets/review.ts'
import { claudeOnce, emptyRoom } from '../runtime/claude-once.ts'
import { cardVerdicts, reviewEvidence } from '../core/held-review.ts'
import { syncKagelets } from '../runtime/kagelets/sync.ts'
import type { Ledgers, runEvents } from '../runtime/ledger.ts'
import type { Store } from '../runtime/store.ts'

type Options = {
  dir: string; kl: NonNullable<Config['kagelets']>; mem: { own: string; owner: string }
  store: Store; ledgers: Ledgers; runs: ReturnType<typeof runEvents>; title: string; notify: (text: string) => void
  hasSdk: () => boolean
  runNow: (id: string, now: number, lead?: string) => string | undefined
  lanes: { busy: (key: string) => boolean; last: (key: string) => number; cut: (key: string) => void }
  toSession: (key: string, task: Task) => Delivery
  idle: (key: string) => boolean; paused: (now: number) => number | undefined
  openHome?: (owners: string[], name: string) => Promise<string>
  tripwires: () => Config['tripwires']
}
type Granted = { grants: Map<string, string[]>; models: Map<string, string>; allows: Map<string, string[]>; refused: boolean }
type Caps = { each: ReturnType<typeof dailyCap>; total: ReturnType<typeof totalCap>; chain: ReturnType<typeof chainCap> }
type Hub = { o: Options; dir: string; max: number; caps: Caps; g: Granted; kmem: ReturnType<typeof kageletMemory>; incidents: ReturnType<typeof kageletIncidents> }

const parsedIn = (dir: string) => readKagelets(dir).map(f => parseKagelet(f.name, f.text)).filter((k): k is Kagelet => !('error' in k))
const rowsIn = (dir: string, costs: string, now: number) => kageletRows(readKagelets(dir), { runs: '', costs, now })

function incidentsOf(o: Options, dir: string, g: Granted) {
  const { kl, store, ledgers } = o
  return kageletIncidents({
    store, perHour: () => kl.incidentsPerHour || 5, stallMs: () => (kl.turnStallMinutes || 20) * 60_000,
    retryable: name => !!rowsIn(dir, '', 0).find(r => r.name === name)?.cron,
    retry: (name, lead, now) => { const why = o.runNow(`kagelet-${name}`, now, lead); log(`kagelet ${name} retries${why ? `: ${why}` : ''}`) },
    pause: (name, now) => log(pauseKagelet(dir, name, true, now)),
    say: o.notify,
    last: (key, transcript) => ({
      words: (transcript ? newLines(transcript, 0).lines : []).flatMap(transcriptSteps).filter(s => s.kind === 'says' || s.kind === 'error').at(-1)?.text ?? '',
      report: ledgers.text('reports').split('\n').map(l => l.split('\t')).filter(r => r[1] === key.split('#side-kagelet-')[1]).at(-1)?.[2] ?? '',
    }),
    live: () => [...g.grants.keys()].map(key => ({ key, busy: o.lanes.busy(key), last: o.lanes.last(key), trace: o.runs.of(key)?.trace })),
    cut: o.lanes.cut,
  })
}

function capPaused(o: Options, rows: KageletRow[], name: string, why: string) {
  const r = rows.find(x => x.name === name)!
  o.ledgers.add('reports', [name, why, 'the owner to resume it, or a higher cap'])
  o.runs.emit(r.key!, 'cap-pause', why)
  o.ledgers.add('waiting', ['open', r.key!.split('#')[0]!, r.link ?? '', `kagelet ${name} ${why}`])
  log(`kagelet ${name} ${why}`)
}

function sync(h: Hub, now: number) {
  const { o, dir, g } = h, { store, ledgers } = o
  migrateKagelets(dir)
  h.incidents.stalls(now)
  let files = readKagelets(dir)
  if (!o.hasSdk() && files.length) { if (!g.refused) log('kagelets need the Agent SDK runner (harness.runtime is not tmux), so none runs'); g.refused = true; files = [] }
  const ran = ledgers.text('runs'), costs = ledgers.text('costs')
  const rows = kageletRows(files, { runs: ran, costs, now })
  for (const f of costFlags(rows, { runs: ran, costs, reports: ledgers.text('reports') }, now)) { ledgers.add('reports', [`${COST_FLAG}${f.name}`, f.line, '']); log(`kagelet cost flag: ${f.line}`) }
  if (costCap({ dir, store, title: o.title, tell: o.notify, flag: (name, why) => capPaused(o, rows, name, why) }, rows, h.caps, now).length) files = readKagelets(dir)
  g.grants = syncKagelets(files, store, now, log, h.max, name => h.kmem.notes(name))
  g.models = new Map(rows.filter(r => r.key && r.model && g.grants.has(r.key)).map(r => [r.key!, r.model!]))
  g.allows = new Map(files.map(f => parseKagelet(f.name, f.text)).flatMap(k => 'allow' in k && k.allow && g.grants.has(k.key) ? [[k.key, k.allow] as const] : []))
}

function reviewOf(o: Options, dir: string) {
  const { kl, ledgers } = o
  return kageletReview({
    settings: () => ({ release: kl.release ?? 'rules', perDay: kl.reviewsPerDay || 10, model: kl.reviewModel || 'haiku' }),
    kagelet: key => parsedIn(dir).find(k => k.key === key),
    ask: a => claudeOnce({ ...a, cwd: emptyRoom(o.dir), tools: '', timeoutMs: 30_000 }),
    event: (key, detail) => o.runs.emit(key, 'held', detail),
    today: () => new Date().toISOString().slice(0, 10),
    evidence: kind => {
      const bar = { minVerdicts: kl.reviewMinVerdicts || 20, minAgreement: kl.reviewMinAgreement ?? 0.95, evidenceDays: kl.reviewEvidenceDays || 30 }
      return reviewEvidence(cardVerdicts(ledgers.text('card-verdicts')), kind, Date.now(), bar)
    },
  })
}

function alwaysAllow(o: Options, dir: string, key: string, tool: string, input: Record<string, unknown>) {
  const k = tool === 'Bash' ? parsedIn(dir).find(x => x.key === key) : undefined, f = k && readKagelets(dir).find(x => x.name === k.name)
  const command = String(input.command ?? ''), next = f && addAllow(f.text, command)
  if (!k || !next || next === f!.text) return
  writeJob(dir, k.name, next)
  o.runs.emit(key, 'held', `always allowed by the owner: ${heldCommand(command)}`)
}

type Talk = { h: Hub; notes: ReturnType<typeof ownerNotes>; manager: ReturnType<typeof kageletManager> }

async function tell(t: Talk, name: string, text: string, runNow: boolean, now: number): Promise<string> {
  const lane = rowsIn(t.h.dir, '', now).find(r => r.name === name)?.key
  if (!lane || !t.h.g.grants.has(lane)) return `no kagelet named "${name}" runs here`
  t.notes.tell(lane, text)
  t.h.o.runs.emit(lane, 'owner-note', `${text.length} characters, from Kage`)
  return runNow ? `told ${name}. ${await t.manager.manage({ action: 'run', name }, now)}` : `told ${name}: its next run reads it`
}

function ask(t: Talk, chat: string, thread: string, name: string, from: string, text: string, now: number): string {
  const { o } = t.h
  const [k] = askable(parsedIn(t.h.dir), chat, thread, name, from)
  if (!k) return ''
  t.notes.asked(k.key, from, text)
  o.runs.emit(k.key, 'people-ask', `${text.length} characters`)
  if (!k.cron && k.after) return `Noted for ${name}. It runs after ${k.after}, and reads this then.`
  if (!t.notes.mayRun(k.key, o.idle(k.key), now, o.kl.askRunsPerHour ?? 4)) return `Noted for ${name}. It reads this on its next run.`
  t.manager.manage({ action: 'run', name }, now).catch(e => log('kagelet ask run failed', e))
  return `Asked ${name}. It answers here.`
}

function hubOf(o: Options): Hub {
  const { kl, ledgers } = o
  const dir = kageletsDir(o.dir), g: Granted = { grants: new Map(), models: new Map(), allows: new Map(), refused: false }
  const kmem = kageletMemory({ dir, forbid: () => [o.mem.own, o.mem.owner], event: e => ledgers.event(e), waiting: cells => ledgers.add('waiting', cells) })
  return { o, dir, g, kmem, max: kl.max || 10, caps: { each: dailyCap(kl), total: totalCap(kl), chain: chainCap(kl) }, incidents: incidentsOf(o, dir, g) }
}

export function hubKagelets(o: Options) {
  const { kl, store, ledgers } = o
  const h = hubOf(o), { dir, g, kmem, incidents } = h
  const syncNow = (now: number) => sync(h, now)
  const parsed = () => parsedIn(dir)
  const measures = kageletMeasures({ store, tripwires: () => o.tripwires() ?? {}, settings: () => ({ measureMinutes: kl.measureMinutes || 60, trendRuns: kl.trendRuns || 5 }),
    event: (who, detail) => ledgers.event({ kind: 'objective', who, trace: '', chain: '', detail }) })
  const reviewHeld = reviewOf(o, dir)
  const board = (key: string) => { const k = parsed().find(x => x.key === key); return k && measures.board(k.name, k.objective) }
  const manager = kageletManager({ dir, max: h.max, ledgers, sync: syncNow, runNow: o.runNow, store, envCommand: kl.dbRead?.command ?? undefined, log, measures, ...(kl.ownersMax !== undefined && { ownersMax: kl.ownersMax }), ...(o.openHome && { openHome: o.openHome }) })
  const notes = ownerNotes(store, () => ({ kept: kl.notesKept ?? NOTE_CAP.kept, chars: kl.noteChars ?? NOTE_CAP.chars }))
  const routes = kageletRoutes({ dir, store, ledgers, runs: o.runs, deliver: kageletDeliver(notes, o.toSession, board),
    idle: o.idle, granted: key => g.grants.has(key), paused: o.paused, capUsd: h.caps.each, chainUsd: h.caps.chain, log, memory: name => kmem.notes(name), done: incidents.ended })
  const needs = kageletNeeds({ store, deliver: o.toSession, idle: o.idle, paused: o.paused, waiting: cells => ledgers.add('waiting', cells), perDay: () => kl.needsPerDay || 5, log })
  const t: Talk = { h, notes, manager }
  return {
    dir, kmem, manager, routes, sync: syncNow, notes, needs, board, measures, incidents, reviewHeld,
    tell: (name: string, text: string, runNow: boolean, now = Date.now()) => tell(t, name, text, runNow, now),
    ask: (chat: string, thread: string, name: string, from: string, text: string, now = Date.now()) => ask(t, chat, thread, name, from, text, now),
    alwaysAllow: (key: string, tool: string, input: Record<string, unknown>) => alwaysAllow(o, dir, key, tool, input),
    peopleIn: (chat: string, thread: string) => askable(parsed(), chat, thread).map(k => ({ name: k.name, people: [...k.people ?? [], ...k.owners ?? []] })),
    measure: (now: number) => measures.tick(parsed(), now).catch(e => log('kagelet measure failed', e)),
    lanes: () => g.grants.keys(),
    grantOf: (key: string) => g.grants.get(key) ?? (key.includes('#side-kagelet-') || key.includes('#side-kdream-') ? [] : undefined),
    modelOf: (key: string) => g.models.get(key),
    allowOf: (key: string) => g.allows.get(key) ?? [],
    budgetOf: (key: string) => key.includes('#side-kagelet-') ? budgetLeft(rowsIn(dir, ledgers.text('costs'), Date.now()), key, h.caps) : undefined,
  }
}
