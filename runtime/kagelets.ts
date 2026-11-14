// Kagelets (#57): the files in the kagelets folder become recurring schedules in a side lane of their thread,
// at teammate trust, and the grants the runner enforces (core/kagelets.ts). The hub syncs them at start and
// each minute, so adding, changing or deleting a file applies within a minute.
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { parseSessionKey } from '../core/conversations.ts'
import { capCheck, chainErrors, COST_FLAG, DB_READ, MAX_CHAIN, NAME, parseKagelet, resultLine, revokeStanding, rowLine, setPaused, kageletFile, kageletRows, type Caps, type Kagelet, type KageletRow, type Standing } from '../core/kagelets.ts'
import { chainLine, chainViews, handoffDetail, whoOf } from '../core/events.ts'
import { loopGuard } from '../core/agents.ts'
import { messageInput, parseMessage, type KageletMessage } from '../core/kagelet-message.ts'
import { kageletTier } from '../core/access.ts'
import type { Store } from './store.ts'
import type { Ledgers, runEvents } from './ledger.ts'
import type { Task } from './protocol.ts'
import type { Delivery } from '../core/sessions.ts'

// The kagelets folder. Only the hub (log given) moves one from before the rename (specialists/) here, once: a kage
// command that moved it would empty the folder under an old hub still running, which then drops every schedule.
// A command reads the old folder where it is. With both there, the new one wins and the hub says so.
export function kageletsDir(dir: string, log?: (line: string) => void) {
  const now = `${dir}/kagelets`, old = `${dir}/specialists`
  if (!existsSync(old)) return now
  if (!existsSync(now)) {
    if (!log) return old
    renameSync(old, now)
    return now
  }
  const left = readKagelets(old).length
  if (log && left) log(`${old} still holds ${left} file${left === 1 ? '' : 's'}, and ${now} is the folder in use: move them in by hand`)
  return now
}

// The folder's .md files. A missing folder is none.
export function readKagelets(dir: string) {
  let names: string[] = []
  try { names = readdirSync(dir).filter(f => f.endsWith('.md')) } catch {}
  // One file that cannot be read (a folder named x.md, a file removed mid-read) is left out, not the whole list.
  return names.flatMap(f => { try { return [{ name: f.slice(0, -3), text: readFileSync(`${dir}/${f}`, 'utf8') }] } catch { return [] } })
}

// kage stop <name>, the p key in kage top and the manager's tool: rewrite the paused line, keep the file.
// The hub's next sync (within a minute) applies it. Returns the line for a person.
export function pauseKagelet(dir: string, name: string, paused: boolean, now = Date.now()): string {
  const file = `${dir}/${name}.md`
  if (!NAME.test(name) || !existsSync(file)) return `There is no kagelet named "${name}".`
  const text = readFileSync(file, 'utf8')
  const next = setPaused(text, paused, now)
  if (next === text) return `${name} is already ${paused ? 'paused' : 'running'}.`
  // A copy swapped in, so the hub never reads a half-written file.
  writeFileSync(`${file}.new`, next, { mode: 0o600 })
  renameSync(`${file}.new`, file)
  return paused ? `${name} is paused within a minute. Its file stays; resume it to run it again.` : `${name} runs again within a minute, from its next scheduled time.`
}

// What each run of a kagelet reads first, scheduled or started by another kagelet.
export const kageletPrompt = (sp: Pick<Kagelet, 'name' | 'job'>) => `You are the kagelet "${sp.name}", run by Kage, its manager. You approve nothing: when the job needs a decision or a tool you do not have, say so in this thread, and the manager or its owner decides. Post what you find in this thread with the reply tool. End every run with the report tool: one line on what you found or did, in needs what you could not do and need from your manager, if anything, and in output the link or short note a kagelet that runs after you takes as its input, if any.\n\n${sp.job}`

const said = new Map<string, string>()   // file name -> the error last logged, so a wrong file is logged once

// Returns the grants: lane key -> its tools.
// max: KAGE_MAX_KAGELETS. Past it, by name order, a kagelet runs nothing and has no grant.
export function syncKagelets(files: { name: string; text: string }[], store: Pick<Store, 'schedules' | 'addSchedule' | 'removeSchedule' | 'seen' | 'conversation'>, now: number, log: (line: string) => void, max = 10) {
  const grants = new Map<string, string[]>()
  const ids = new Set<string>()
  let running = 0
  const parsed = files.map(f => parseKagelet(f.name, f.text)).filter((p): p is Kagelet => !('error' in p))
  const broken = chainErrors(parsed)
  for (const f of [...files].sort((a, b) => a.name.localeCompare(b.name))) {
    let sp = parseKagelet(f.name, f.text)
    if (!('error' in sp) && broken.has(sp.name)) sp = { error: broken.get(sp.name)! }
    if (!('error' in sp) && !sp.paused && ++running > max) sp = { error: `this install runs at most ${max} kagelets (KAGE_MAX_KAGELETS)` }
    if ('error' in sp) {
      if (said.get(f.name) !== sp.error) log(`kagelet ${f.name} does not run: ${sp.error}`)
      said.set(f.name, sp.error)
      continue
    }
    said.delete(f.name)
    const id = `kagelet-${sp.name}`
    // Paused: no schedule, but a turn still running keeps its grant.
    grants.set(sp.key, sp.tools)
    if (sp.paused) continue
    // One that runs only after another has no schedule, but its lane needs its thread to start a run in.
    if (!sp.cron) { if (!store.conversation(sp.key)) store.seen(sp.key, parseSessionKey(sp.key)!.conversation, `${sp.name} (kagelet)`, now); continue }
    ids.add(id)
    const prompt = kageletPrompt(sp)
    // A schedule from before the rename (spec-<name> in a #side-spec- lane) hands over when it last ran.
    const cur = store.schedules().find(s => s.id === id) ?? store.schedules().find(s => s.id === `spec-${sp.name}`)
    if (cur && cur.key === sp.key && cur.cron === sp.cron && cur.prompt === prompt) continue
    if (cur) store.removeSchedule(cur.id)
    store.seen(sp.key, parseSessionKey(sp.key)!.conversation, `${sp.name} (kagelet)`, now)
    store.addSchedule({ id, key: sp.key, cron: sp.cron, prompt, recurring: true, fromOwner: false, created: cur?.created ?? now, lastFired: cur?.lastFired ?? 0 })
  }
  // A removed kagelet goes with every schedule in its lane, the ones it added itself too.
  // Every schedule in a lane from before the rename goes: its kagelet now runs in its new lane.
  for (const s of store.schedules()) if ((s.id.startsWith('kagelet-') && !ids.has(s.id)) || (s.key.includes('#side-kagelet-') && !grants.has(s.key)) || s.key.includes('#side-spec-')) store.removeSchedule(s.id)
  return grants
}

// The command a kagelet's db_read runs: KAGE_DB_READ_COMMAND wins, else the one this kagelet saved with.
// Read on each call, so a change applies with no restart.
const READ_COMMANDS = 'db-read-commands'
// One command for every kagelet, from before each had its own: still read for a kagelet with none, never written.
const OLD_READ_COMMAND = 'db-read-command'
// The standing approvals (core/kagelets.ts Standing), kept in the store beside the commands.
const STANDING = 'standing-approvals'
const commands = (store: Pick<Store, 'load'>) => (store.load(READ_COMMANDS) ?? {}) as Record<string, string>
export const readCommand = (envCommand: string | undefined, store: Pick<Store, 'load'>, kagelet: string) =>
  envCommand || commands(store)[kagelet] || (store.load(OLD_READ_COMMAND) as string | undefined)
const standings = (store: Pick<Store, 'load'>) => (store.load(STANDING) ?? {}) as Standing

// The owner's answer to Kage's approval card (runtime/sdk-sessions.ts): true only on their yes.
// tools: the write tools the card grants.
export type AskOwner = (card: { kagelet: string; tools: string; job: string }) => Promise<boolean>

// The manager's side (Kage's owner sessions, runtime/kage-tools.ts): write, pause, run and remove kagelet files.
// The hub syncs right after a change, so run works at once; the minute sync applies it anyway.
// read_command: names one of the install's read commands for db_read. revoke: name is the tool.
// No field here says who asked: the model fills every one, so none may widen a grant.
export type Manage = { action: 'save' | 'pause' | 'resume' | 'run' | 'remove' | 'revoke'; name: string; thread?: string; schedule?: string; after?: string; tools?: string[]; job?: string; why?: string; read_command?: string }
export function kageletManager(o: { dir: string; max: number; ledgers: { text(name: 'runs' | 'costs' | 'reports'): string } & Pick<Ledgers, 'add' | 'events'>; sync: (now: number) => void; runNow: (id: string, now: number) => string | undefined; store: Pick<Store, 'load' | 'save'>; envCommand?: string; log: (line: string) => void }) {
  // Once: the standing approval from before tiers ({ tool, command, at }) covered db_read alone, which is read now.
  if (typeof (o.store.load(STANDING) as { tool?: unknown } | undefined)?.tool === 'string') o.store.save(STANDING, undefined)
  const rows = (now: number) => kageletRows(readKagelets(o.dir), { runs: o.ledgers.text('runs'), costs: o.ledgers.text('costs'), reports: o.ledgers.text('reports'), now })
  // A grants row: kagelet, read | granted | standing | refused | revoked, why, the tools. Never a read command.
  const row = (name: string, status: string, why: string, tools: string[]) => o.ledgers.add('grants', [name, status, why, tools.join(', ')])
  return {
    list(now: number): string {
      const all = rows(now)
      if (!all.length) return 'No kagelets yet.'
      // Today's cost flag (core/kagelets.ts costFlags), if the hub filed one.
      const midnight = new Date(now).setHours(0, 0, 0, 0)
      const flags = new Map(o.ledgers.text('reports').split('\n').map(l => l.split('\t')).filter(([at = '', n = '']) => n.startsWith(COST_FLAG) && Date.parse(at) >= midnight).map(([, n, line]) => [n!.slice(COST_FLAG.length), line!]))
      // One line per chain today: its steps and where it stopped (#93).
      const chains = chainViews(o.ledgers.events(new Date(now).toISOString().slice(0, 10))).map(c => `  ${chainLine(c)}`)
      return [...all.map(r => `${rowLine(r, now)}\n  made by ${r.by === 'kage' ? 'Kage' : 'the owner'}${r.why ? `: ${r.why}` : ''}\n  last report: ${resultLine(r, now)}${flags.has(r.name) ? `\n  cost flag today: ${flags.get(r.name)}` : ''}`),
        ...chains.length ? [`Chains today:\n${chains.join('\n')}`] : []].join('\n')
    },
    // ask: the owner's card, needed only for a write tool no standing approval covers.
    async manage(a: Manage, now: number, ask?: AskOwner): Promise<string> {
      if (a.action === 'revoke') {
        // Files first, the store row last, and the files are read even with no row: a revoke that stopped halfway
        // finishes when run again.
        const tool = a.name
        const yes = standings(o.store)
        const out = revokeStanding(readKagelets(o.dir), tool)
        if (!out.length && yes[tool] === undefined) return `There is no standing approval for ${tool}.`
        for (const f of out) {
          writeFileSync(`${o.dir}/${f.name}.md.new`, f.text, { mode: 0o600 })
          renameSync(`${o.dir}/${f.name}.md.new`, `${o.dir}/${f.name}.md`)
          row(f.name, 'revoked', 'the owner revoked its standing approval', [tool])
          o.log(`kagelet ${f.name}: ${tool} revoked with the standing approval`)
        }
        const { [tool]: _, ...rest } = yes
        o.store.save(STANDING, Object.keys(rest).length ? rest : undefined)
        o.sync(now)
        return `revoked the standing approval for ${tool}. ${out.length ? `It no longer grants it to ${out.map(f => f.name).join(', ')}.` : 'No kagelet held it by that approval.'} The next kagelet that asks for it asks the owner on a card.`
      }
      if (!NAME.test(a.name)) return `"${a.name}" is not a kagelet name: a short lowercase name, letters, digits, dashes.`
      const file = `${o.dir}/${a.name}.md`
      if (a.action === 'pause' || a.action === 'resume') {
        const said = pauseKagelet(o.dir, a.name, a.action === 'pause', now)
        o.sync(now)
        return said
      }
      if (!existsSync(file) && a.action !== 'save') return `There is no kagelet named "${a.name}".`
      if (a.action === 'remove') {
        unlinkSync(file)
        const { [a.name]: _, ...rest } = commands(o.store)
        o.store.save(READ_COMMANDS, Object.keys(rest).length ? rest : undefined)
        o.sync(now)
        return `removed ${a.name}: its file and its schedule are gone.`
      }
      if (a.action === 'run') {
        const r = rows(now).find(x => x.name === a.name)!
        if (r.state !== 'runs') return `${a.name} does not run now: it is ${r.state === 'paused' ? 'paused. Resume it first' : `broken (${r.error})`}.`
        o.sync(now)
        return o.runNow(`kagelet-${a.name}`, now) ?? `${a.name} is running now. Its report shows in the list when it ends.`
      }
      // Kage approves by tier (core/access.ts), from code: the model writes every field of this call, in the
      // owner's sessions too (thread content can steer one), so none of them can widen a grant.
      const tools = a.tools ?? []
      const old = existsSync(file) ? parseKagelet(a.name, readFileSync(file, 'utf8')) : undefined
      const had = old && !('error' in old) ? old : undefined
      const fresh = tools.filter(t => !had?.tools.includes(t))
      // Every refused save that would have granted something new leaves a ledger row and a log line.
      const refuse = (why: string) => {
        if (fresh.length) { row(a.name, 'refused', why, fresh); o.log(`kagelet ${a.name}: ${fresh.join(', ')} refused: ${why}`) }
        return `not saved: ${why}`
      }
      if (!old && readKagelets(o.dir).length >= o.max) return refuse(`this install has at most ${o.max} kagelets (KAGE_MAX_KAGELETS). Remove one first, or ask the owner to raise it.`)
      // after: refused when it names a missing kagelet, closes a cycle or goes too deep, with this file in place.
      const others = readKagelets(o.dir).filter(f => f.name !== a.name).map(f => parseKagelet(f.name, f.text)).filter((p): p is Kagelet => !('error' in p))
      // Also refused when it breaks a step after it (a tool taken away that the next step holds).
      const errors = chainErrors([...others, { name: a.name, ...(a.after && { after: a.after }), tools }])
      const chained = errors.get(a.name) ?? [...errors].find(([n]) => others.some(x => x.name === n && x.after === a.name))?.[1]
      if (chained) return refuse(chained)
      // Who made it is what the hub knows: a file that exists keeps its maker (a hand-written one is the owner's),
      // and a new one is Kage's, since only Kage's tool writes it.
      const by = had ? had.by : 'kage'
      const fileText = (approved: boolean, standing: string[] = []) => kageletFile({ thread: a.thread ?? '', schedule: a.schedule ?? '', ...(a.after && { after: a.after }), tools, job: a.job ?? '', by, why: a.why ?? '', paused: !!had?.paused, approved, standing })
      // Checked as if approved first, so an act tool or a file that would not run is refused before any card.
      const valid = fileText(true)
      if (typeof valid !== 'string') return refuse(valid.error)
      // db_read reads through a command the install already has: KAGE_DB_READ_COMMAND, else one the owner approved
      // before (kept in the store). A kagelet never brings a new one.
      let command: string | undefined
      if (tools.includes(DB_READ) && !o.envCommand) {
        const known = [...new Set([...Object.values(commands(o.store)), o.store.load(OLD_READ_COMMAND) as string | undefined].filter((c): c is string => !!c))]
        command = a.read_command?.trim() || commands(o.store)[a.name] || (known.length === 1 ? known[0] : undefined)
        if (!known.length) return refuse(`${DB_READ} reads through the install's read command, and none is set: the owner sets KAGE_DB_READ_COMMAND`)
        if (!command) return refuse(`${DB_READ}: pass read_command, one of the install's read commands`)
        if (!known.includes(command)) return refuse(`a kagelet never gets a read command the install does not already have: the owner sets KAGE_DB_READ_COMMAND`)
      }
      // Write tools: one it already held by a card or by hand stays; a standing approval covers the next; the rest
      // take one card. Only a session that can ask the owner grants a write tool, standing approval or not.
      const yes = standings(o.store)
      const writes = tools.filter(t => kageletTier(t) === 'write')
      const kept = writes.filter(t => had?.tools.includes(t) && !had.standing?.includes(t))
      const standing = writes.filter(t => !kept.includes(t) && yes[t] !== undefined)
      const card = writes.filter(t => !kept.includes(t) && yes[t] === undefined)
      if ((card.length || standing.some(t => fresh.includes(t))) && !ask) return refuse(`only the owner grants ${[...card, ...standing].join(', ')}, and this session cannot ask them`)
      if (card.length && !await ask!({ kagelet: a.name, tools: card.join(', '), job: (a.job ?? '').trim().split('\n')[0]!.slice(0, 300) })) return refuse(`the owner did not approve ${card.join(', ')}`)
      const text = fileText(true, standing)
      if (typeof text !== 'string') return refuse(text.error)
      if (card.length) o.store.save(STANDING, { ...yes, ...Object.fromEntries(card.map(t => [t, now])) })
      if (command) o.store.save(READ_COMMANDS, { ...commands(o.store), [a.name]: command })
      mkdirSync(o.dir, { recursive: true, mode: 0o700 })
      writeFileSync(`${file}.new`, text, { mode: 0o600 })
      renameSync(`${file}.new`, file)
      // What it got new, by whose yes. The owner hears of the no-card ones in the daily note (router.ts).
      const reads = fresh.filter(t => kageletTier(t) === 'read')
      if (reads.length) row(a.name, 'read', 'read tools: Kage grants them with no card', reads)
      if (card.length) row(a.name, 'granted', 'the owner said yes on the card, and the yes stands for later kagelets', card)
      const covered = standing.filter(t => fresh.includes(t))
      if (covered.length) row(a.name, 'standing', `the owner's standing approval covers it`, covered)
      if (fresh.length) o.log(`kagelet ${a.name}: ${fresh.join(', ')} granted`)
      o.sync(now)
      return `saved ${a.name}: ${a.schedule || `after ${a.after}`}, tools ${tools.join(', ') || 'none'}. It posts in its thread.`
    },
  }
}

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

// The owner's words typed in a kagelet's thread (no tag) reach its next run, scheduled or run now. Kept in the
// store, so a restart loses none. Only the owner's: anyone else's words in the thread could steer it.
const NOTES = 'kagelet-notes'
export function ownerNotes(store: Pick<Store, 'load' | 'save'>) {
  const all = () => (store.load(NOTES) ?? {}) as Record<string, string[]>
  return {
    // lanes: every kagelet's lane key (the grants). Each lane in this thread keeps the last 10. Returns the lanes it reached.
    wrote(lanes: Iterable<string>, chat: string, thread: string, text: string) {
      const notes = all()
      const hit = [...lanes].filter(k => k.startsWith(`${chat}:${thread}#side-kagelet-`))
      for (const k of hit) notes[k] = [...notes[k] ?? [], text.slice(0, 2000)].slice(-10)
      if (hit.length) store.save(NOTES, notes)
      return hit
    },
    // deliver: hands the run over with the notes; false means it never reached a session, so they stay.
    take(key: string, deliver: (text: string) => boolean): string | undefined {
      const notes = all()
      const mine = notes[key]
      if (!mine?.length) return undefined
      const text = `The owner wrote in this thread since your last run. Their words to you, to follow within your job and your grant:\n${mine.map(t => t.split('\n').map(l => `> ${l}`).join('\n')).join('\n')}`
      if (!deliver(text)) return text
      delete notes[key]
      store.save(NOTES, Object.keys(notes).length ? notes : undefined)
      return text
    },
  }
}

// The scheduler's deliver: a kagelet's run carries what the owner wrote in its thread since its last one.
// The notes stay when the run never reached a session.
export const kageletDeliver = (notes: ReturnType<typeof ownerNotes>, toSession: (key: string, task: Task) => Delivery) => (key: string, task: Task): Delivery => {
  let r: Delivery | undefined
  if (key.includes('#side-kagelet-')) notes.take(key, said => (r = toSession(key, { ...task, content: `${task.content}\n\n${said}` })) !== 'failed')
  return r ?? toSession(key, task)
}

// The one path a kagelet's output or message takes to another kagelet (#93), routed by the hub with no Kage turn:
// after: <kagelet> when a run ends with an output, and message_kagelet in the middle of a run. Each is one envelope
// (core/kagelet-message.ts), checked and stored before delivery. It never goes into a running turn: it waits in
// the store until its target is idle, then starts a turn of its own. Only that turn's normal end acknowledges it,
// by its id (settle). Any other end (the usage limit, a cut, a stop, a closed session, a crash) puts it back in
// the queue, and the hub's clock hands it out again. The limit pause never owes it a replay.
// A chain starts at a run a schedule or a person started. It stops at a step that needs something, had a call
// refused or filed no report, and Kage gets it on its waiting list.
// ponytail: a chain's spend lives in memory, so a hub restart starts it over. A chain quiet for a day is dropped.
export function kageletRoutes(o: {
  dir: string; store: Pick<Store, 'conversation' | 'putMessage' | 'messageState' | 'handed' | 'unread'>
  ledgers: Pick<Ledgers, 'add' | 'text' | 'event'>; runs: ReturnType<typeof runEvents>
  deliver: (key: string, task: Task) => Delivery
  // Ready for a turn of its own now: no turn running or starting, no closed thread, and a session slot it can take.
  idle: (key: string) => boolean
  // The usage-limit pause (runtime/limit-pause.ts) and its reset time: no message goes, and none ages.
  paused: (now: number) => number | undefined
  capUsd?: number; chainUsd?: number; log: (line: string) => void; newId?: () => string
}) {
  const chains = new Map<string, { usd: number; at: number }>()
  // 20 a minute per pair, as for a teammate's agent (core/agents.ts). Hops travel in each message and on its run.
  const guard = loopGuard({ perWindow: 20, windowMs: 60_000, hops: Infinity })
  const chainOf = (id: string, now: number) => {
    for (const [k, c] of chains) if (c.at < now - 86_400_000) { chains.delete(k); guard.person(k) }
    const c = chains.get(id) ?? chains.set(id, { usd: 0, at: now }).get(id)!
    c.at = Math.max(c.at, now)
    return c
  }
  const outputs = new Map<string, { needs: string; output: string }>()   // lane -> its run's report
  const laneOf = (name: string) => kageletRows(readKagelets(o.dir), { runs: '', costs: '', now: 0 }).find(r => r.name === name)?.key ?? ''
  const stop = (key: string, chain: string, why: string) => {
    o.runs.emit(key, 'handoff', `stopped: ${why}`)
    o.ledgers.add('waiting', ['open', key.split('#')[0]!, '', `chain ${chain} stopped at ${whoOf(key)}: ${why}`])
  }
  // Why a stored message can never go to its target, 'waits' while it cannot go yet, or the task it starts there.
  function check(m: KageletMessage, now: number): { why: string } | 'waits' | { key: string; task: Task } {
    const all = readKagelets(o.dir)
    const rows = kageletRows(all, { runs: o.ledgers.text('runs'), costs: o.ledgers.text('costs'), now })
    const row = rows.find(r => r.name === m.to), sp = all.find(f => f.name === m.to)
    const from = rows.find(r => r.name === m.from)
    const c = chainOf(m.contextId, now)
    // A message is untrusted input (its sender may read the web): it never reaches a kagelet that holds more.
    const wider = row?.tools.find(t => !(from?.tools ?? []).includes(t))
    const why = !row || !sp ? `there is no kagelet named "${m.to}"`
      : row.state === 'broken' ? `${m.to} is broken (${row.error})`
      : wider ? `${m.to} holds ${wider}, which ${m.from} does not. A kagelet messages only one with the same tools or fewer.`
      : o.chainUsd !== undefined && c.usd >= o.chainUsd ? `the chain spent $${c.usd.toFixed(2)}, at or over its cap of $${o.chainUsd.toFixed(2)} (KAGE_KAGELET_CHAIN_USD)`
      : m.hops > MAX_CHAIN - 1 ? `${m.hops} hops with no person or schedule in between (the limit is ${MAX_CHAIN - 1})`
      : undefined
    if (why) return { why }
    // A paused kagelet, or one at its daily cap, keeps its messages until it runs again or they expire.
    const conversation = o.store.conversation(row!.key!)
    if (row!.state === 'paused' || o.capUsd !== undefined && row!.costToday >= o.capUsd || !conversation || o.paused(now) !== undefined || !o.idle(row!.key!)) return 'waits'
    return { key: row!.key!, task: {
      type: 'task', fromOwner: false, scheduled: true, handoff: { chain: m.contextId, message: m.messageId, hops: m.hops },
      content: `${kageletPrompt(parseKagelet(m.to, sp!.text) as Kagelet)}\n\n${messageInput(m)}`,
      meta: { channel: conversation.conversation.chat, thread_ts: conversation.conversation.thread ?? '', place: conversation.place, permalink: '' },
      origin: { channel: conversation.conversation.chat, ts: '' },
    } }
  }
  const kindOf = (m: KageletMessage) => /^https?:\/\//.test(m.parts[0]!.text) ? 'link' : 'note'
  const fail = (m: KageletMessage, why: string) => {
    o.ledgers.event({ kind: 'handoff', who: m.from, trace: m.taskId, chain: m.contextId, detail: handoffDetail(m.to, kindOf(m), why) })
    o.store.messageState(m.messageId, 'failed', why)
    o.ledgers.add('waiting', ['open', laneOf(m.from).split('#')[0]!, '', `chain ${m.contextId} stopped before ${m.to}: ${why}`])
    o.log(`chain ${m.contextId}: ${m.from} > ${m.to} failed: ${why}`)
  }
  // A stored message to its idle target as a turn of its own. 'sent', 'waits' or why it failed for good.
  function deliver(m: KageletMessage, now: number): string {
    const ok = check(m, now)
    if (ok === 'waits') return 'waits'
    if ('why' in ok) { fail(m, ok.why); return ok.why }
    // Only a session that started counts. The idle check rules out a hold, a closed thread, a busy session and a full
    // house, so anything else means it did not start.
    const r = o.deliver(ok.key, ok.task)
    if (r !== 'sent' && r !== 'starting') return 'waits'
    o.store.handed(m.messageId, now)
    o.ledgers.event({ kind: 'handoff', who: m.from, trace: m.taskId, chain: m.contextId, detail: handoffDetail(m.to, kindOf(m)) })
    return 'sent'
  }
  // A new message from a running kagelet: built, checked, stored, then delivered now or once its target is idle.
  // handoff: an after: output, which no one sees refused, so a refusal stops its chain.
  function send(fromKey: string, to: string, text: string, now: number, handoff = false): string {
    const run = o.runs.of(fromKey)
    if (!run) return 'not sent: this run is not open'
    const chain = run.chain ||= run.trace
    const m = parseMessage({ messageId: (o.newId ?? randomUUID)(), contextId: chain, taskId: run.trace, from: whoOf(fromKey), to, role: 'agent',
      parts: [{ kind: 'text', text }], hops: run.hops + 1 })
    if ('error' in m) {
      if (handoff) stop(fromKey, chain, `its output could not go to ${to}: ${m.error}`)
      return `not sent: ${m.error}`
    }
    // Counted once, when sent: a message waiting for its target is not a new turn.
    const flood = guard.turn(`${m.from}>${m.to}`, chain, now)
    o.store.putMessage(m, now)
    if (flood) { fail(m, flood); return `not sent: ${flood}` }
    const r = deliver(m, now)
    return r === 'sent' ? `sent to ${to}` : r === 'waits' ? `queued for ${to}, which is busy or paused: it reads this in a turn of its own once it can` : `not sent: ${r}`
  }
  // On the hub's clock: a queued message an hour past its first run (or its sending, if no run took it yet) fails;
  // each idle kagelet takes its oldest waiting one. A running turn ends on its own, so a delivered one never expires.
  // A usage-limit pause stops that hour: it counts again from the reset.
  let resumed = 0
  function pump(now: number) {
    const reset = o.paused(now)
    if (reset !== undefined) { resumed = reset; return }
    for (const u of o.store.unread()) {
      if (u.state !== 'queued') continue
      if (now - Math.max(u.tried ?? u.at, resumed) > 3_600_000) fail(u.message, 'no run of its target finished it within an hour')
      else deliver(u.message, now)
    }
  }
  return {
    message(fromKey: string, to: string, text: string, now = Date.now()): string {
      if (whoOf(fromKey) === fromKey) return 'not sent: only a kagelet can message a kagelet'
      return send(fromKey, to, text, now)
    },
    pump,
    // The end of a turn that carried messages: read only when it ended normally (done), else queued again.
    settle(tasks: Task[], done: boolean) {
      for (const t of tasks) if (t.handoff) o.store.messageState(t.handoff.message, done ? 'read' : 'queued')
    },
    // At the start: a message no turn finished (the hub stopped first) waits again.
    replay(now: number) {
      for (const u of o.store.unread()) if (u.state === 'delivered') o.store.messageState(u.message.messageId, 'queued')
      pump(now)
    },
    // The report tool: what the run needs and its output, for its end.
    reported(key: string, r: { needs: string; output: string }) { outputs.set(key, r) },
    // A turn ended with its result: stop the chain on a failed step, else hand the output on; then end the run.
    // limited: it ended on the usage limit and did nothing, so only its spend counts. Its message runs again.
    ended(key: string, usd: number, transcript: string, now = Date.now(), limited = false) {
      const run = o.runs.of(key)
      const out = outputs.get(key)
      outputs.delete(key)
      if (run?.chain) chainOf(run.chain, now).usd += usd
      if (run && !limited && key.includes('#side-kagelet-')) {
        const name = whoOf(key)
        const why = !run.reported ? 'ended without a report' : out?.needs ? `needs ${out.needs}` : run.refused ? 'a tool call was refused, so it needs approval' : undefined
        const next = readKagelets(o.dir).map(f => parseKagelet(f.name, f.text)).filter((p): p is Kagelet => !('error' in p) && p.after === name)
        if (why && run.chain) stop(key, run.chain, why)
        else if (!why && out?.output && next.length) {
          if (!run.chain) { run.chain = run.trace; chainOf(run.chain, now).usd += usd }
          for (const n of next) send(key, n.name, out.output, now, true)
        }
      }
      o.runs.end(key, `$${usd.toFixed(2)}`, transcript)
    },
  }
}
