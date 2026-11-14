// Kagelets (#57): the files in the kagelets folder become recurring schedules in a side lane of their thread,
// at teammate trust, and the grants the runner enforces (core/kagelets.ts). The hub syncs them at start and
// each minute, so adding, changing or deleting a file applies within a minute.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { parseSessionKey } from '../core/conversations.ts'
import { DB_READ, NAME, parseKagelet, resultLine, rowLine, setPaused, kageletFile, kageletRows, type Maker, type KageletRow } from '../core/kagelets.ts'
import type { Store } from './store.ts'
import type { Ledgers } from './ledger.ts'

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

const said = new Map<string, string>()   // file name -> the error last logged, so a wrong file is logged once

// Returns the grants: lane key -> its tools.
// max: KAGE_MAX_KAGELETS. Past it, by name order, a kagelet runs nothing and has no grant.
export function syncKagelets(files: { name: string; text: string }[], store: Pick<Store, 'schedules' | 'addSchedule' | 'removeSchedule' | 'seen'>, now: number, log: (line: string) => void, max = 10) {
  const grants = new Map<string, string[]>()
  const ids = new Set<string>()
  let running = 0
  for (const f of [...files].sort((a, b) => a.name.localeCompare(b.name))) {
    let sp = parseKagelet(f.name, f.text)
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
    ids.add(id)
    const prompt = `You are the kagelet "${sp.name}", run by Kage, its manager. You approve nothing: when the job needs a decision or a tool you do not have, say so in this thread, and the manager or its owner decides. Post what you find in this thread with the reply tool. End every run with the report tool: one line on what you found or did, and in needs what you could not do and need from your manager, if anything.\n\n${sp.job}`
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

// The command db_read runs: KAGE_DB_READ_COMMAND wins, else the one the owner approved on Kage's card.
// Read on each call, so a yes applies with no restart.
const READ_COMMAND = 'db-read-command'
export const readCommand = (envCommand: string | undefined, store: Pick<Store, 'load'>) => envCommand || (store.load(READ_COMMAND) as string | undefined)

// The owner's answer to Kage's approval card (runtime/sdk-sessions.ts): true only on their yes.
export type AskOwner = (card: { kagelet: string; read_command: string; job: string }) => Promise<boolean>

// The manager's side (Kage's owner sessions, runtime/kage-tools.ts): write, pause, run and remove kagelet files.
// The hub syncs right after a change, so run works at once; the minute sync applies it anyway.
// read_command: the read command Kage proposes with a db_read grant.
export type Manage = { action: 'save' | 'pause' | 'resume' | 'run' | 'remove'; name: string; thread?: string; schedule?: string; tools?: string[]; job?: string; by?: Maker; why?: string; read_command?: string }
export function kageletManager(o: { dir: string; max: number; ledgers: { text(name: 'runs' | 'costs' | 'reports'): string } & Pick<Ledgers, 'add'>; sync: (now: number) => void; runNow: (id: string, now: number) => string | undefined; store: Pick<Store, 'load' | 'save'>; envCommand?: string; log: (line: string) => void }) {
  const rows = (now: number) => kageletRows(readKagelets(o.dir), { runs: o.ledgers.text('runs'), costs: o.ledgers.text('costs'), reports: o.ledgers.text('reports'), now })
  return {
    list(now: number): string {
      const all = rows(now)
      if (!all.length) return 'No kagelets yet.'
      return all.map(r => `${rowLine(r, now)}\n  made by ${r.by === 'kage' ? 'Kage' : 'the owner'}${r.why ? `: ${r.why}` : ''}\n  last report: ${resultLine(r, now)}`).join('\n')
    },
    // ask: the owner's card, needed only to grant db_read.
    async manage(a: Manage, now: number, ask?: AskOwner): Promise<string> {
      if (!NAME.test(a.name)) return `"${a.name}" is not a kagelet name: a short lowercase name, letters, digits, dashes.`
      const file = `${o.dir}/${a.name}.md`
      if (a.action === 'pause' || a.action === 'resume') {
        const said = pauseKagelet(o.dir, a.name, a.action === 'pause', now)
        o.sync(now)
        return said
      }
      if (!existsSync(file) && a.action !== 'save') return `There is no kagelet named "${a.name}".`
      if (a.action === 'remove') { unlinkSync(file); o.sync(now); return `removed ${a.name}: its file and its schedule are gone.` }
      if (a.action === 'run') {
        const r = rows(now).find(x => x.name === a.name)!
        if (r.state !== 'runs') return `${a.name} does not run now: it is ${r.state === 'paused' ? 'paused. Resume it first' : `broken (${r.error})`}.`
        o.sync(now)
        return o.runNow(`kagelet-${a.name}`, now) ?? `${a.name} is running now. Its report shows in the list when it ends.`
      }
      const db = !!a.tools?.includes(DB_READ)
      // Every db_read save, granted or refused, leaves a ledger row and a log line. Never the command: it may hold a host.
      const refuse = (why: string) => {
        if (db) { o.ledgers.add('grants', [a.name, 'refused', why]); o.log(`kagelet ${a.name}: ${DB_READ} refused: ${why}`) }
        return `not saved: ${why}`
      }
      const old = existsSync(file) ? parseKagelet(a.name, readFileSync(file, 'utf8')) : undefined
      if (!old && readKagelets(o.dir).length >= o.max) return refuse(`this install has at most ${o.max} kagelets (KAGE_MAX_KAGELETS). Remove one first, or ask the owner to raise it.`)
      const text = kageletFile({ thread: a.thread ?? '', schedule: a.schedule ?? '', tools: a.tools ?? [], job: a.job ?? '', by: a.by ?? (old && !('error' in old) ? old.by : 'kage'), why: a.why ?? '', paused: !!old && !('error' in old) && old.paused, ...(db && { granted: now }) })
      if (typeof text !== 'string') return refuse(text.error)
      if (db) {
        // The database grant is the owner's alone: only their yes on the card saves it.
        if (!ask) return refuse(`only the owner grants ${DB_READ}, and this session cannot ask them`)
        const command = o.envCommand || a.read_command?.trim() || readCommand(undefined, o.store)
        if (!command) return refuse(`${DB_READ} needs a read command: pass read_command, the owner's command that runs one read-only query`)
        // The command before the job line, so a long job never pushes it past the card's cut. An env command is
        // named, not shown: it is the one most likely to hold a host or a password.
        const card = { kagelet: a.name, read_command: o.envCommand ? 'KAGE_DB_READ_COMMAND, as set in the settings file' : command, job: (a.job ?? '').trim().split('\n')[0]!.slice(0, 300) }
        if (!await ask(card)) return refuse(`the owner did not approve ${DB_READ}`)
        if (!o.envCommand) o.store.save(READ_COMMAND, command)
        o.ledgers.add('grants', [a.name, 'granted', 'the owner said yes on the card'])
        o.log(`kagelet ${a.name}: ${DB_READ} granted by the owner`)
      }
      mkdirSync(o.dir, { recursive: true, mode: 0o700 })
      writeFileSync(`${file}.new`, text, { mode: 0o600 })
      renameSync(`${file}.new`, file)
      o.sync(now)
      return `saved ${a.name}: ${a.schedule}, tools ${(a.tools ?? []).join(', ') || 'none'}. It posts in its thread.`
    },
  }
}

// KAGE_KAGELET_DAILY_USD: a kagelet whose lane spent the cap today is paused (its file says so) and flagged.
// It stays paused past midnight: a resume is the owner's or the manager's call. Returns who was paused.
export function costCap(dir: string, rows: KageletRow[], capUsd: number, flag: (name: string, why: string) => void): string[] {
  const over = rows.filter(r => r.state === 'runs' && r.costToday >= capUsd)
  for (const r of over) {
    pauseKagelet(dir, r.name, true)
    flag(r.name, `paused: it spent $${r.costToday.toFixed(2)} today, at or over its daily cap of $${capUsd.toFixed(2)} (KAGE_KAGELET_DAILY_USD)`)
  }
  return over.map(r => r.name)
}

// The owner's words typed in a kagelet's thread (no tag) reach its next run, scheduled or run now. Kept in the
// store, so a restart loses none. Only the owner's: anyone else's words in the thread could steer it.
const NOTES = 'kagelet-notes'
export function ownerNotes(store: Pick<Store, 'load' | 'save'>) {
  const all = () => (store.load(NOTES) ?? {}) as Record<string, string[]>
  return {
    // lanes: every kagelet's lane key (the grants). Each lane in this thread keeps the last 10.
    wrote(lanes: Iterable<string>, chat: string, thread: string, text: string) {
      const notes = all()
      let hit = false
      for (const k of lanes) if (k.startsWith(`${chat}:${thread}#side-kagelet-`)) { notes[k] = [...notes[k] ?? [], text.slice(0, 2000)].slice(-10); hit = true }
      if (hit) store.save(NOTES, notes)
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
