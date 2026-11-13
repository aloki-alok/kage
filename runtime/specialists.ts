// Specialists (#57): the files in the specialists folder become recurring schedules in a side lane of their thread,
// at teammate trust, and the grants the runner enforces (core/specialists.ts). The hub syncs them at start and
// each minute, so adding, changing or deleting a file applies within a minute.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { parseSessionKey } from '../core/conversations.ts'
import { NAME, parseSpecialist, resultLine, rowLine, setPaused, specialistFile, specialistRows, type Maker, type SpecialistRow } from '../core/specialists.ts'
import type { Store } from './store.ts'

// The folder's .md files. A missing folder is none.
export function readSpecialists(dir: string) {
  let names: string[] = []
  try { names = readdirSync(dir).filter(f => f.endsWith('.md')) } catch {}
  // One file that cannot be read (a folder named x.md, a file removed mid-read) is left out, not the whole list.
  return names.flatMap(f => { try { return [{ name: f.slice(0, -3), text: readFileSync(`${dir}/${f}`, 'utf8') }] } catch { return [] } })
}

// kage stop <name>, the p key in kage top and the manager's tool: rewrite the paused line, keep the file.
// The hub's next sync (within a minute) applies it. Returns the line for a person.
export function pauseSpecialist(dir: string, name: string, paused: boolean): string {
  const file = `${dir}/${name}.md`
  if (!NAME.test(name) || !existsSync(file)) return `There is no specialist named "${name}".`
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
// max: KAGE_MAX_SPECIALISTS. Past it, by name order, a specialist runs nothing and has no grant.
export function syncSpecialists(files: { name: string; text: string }[], store: Pick<Store, 'schedules' | 'addSchedule' | 'removeSchedule' | 'seen'>, now: number, log: (line: string) => void, max = 10) {
  const grants = new Map<string, string[]>()
  const ids = new Set<string>()
  let running = 0
  for (const f of [...files].sort((a, b) => a.name.localeCompare(b.name))) {
    let sp = parseSpecialist(f.name, f.text)
    if (!('error' in sp) && !sp.paused && ++running > max) sp = { error: `this install runs at most ${max} specialists (KAGE_MAX_SPECIALISTS)` }
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
    const prompt = `You are the specialist "${sp.name}", run by Kage, its manager. You approve nothing: when the job needs a decision or a tool you do not have, say so in this thread, and the manager or its owner decides. Post what you find in this thread with the reply tool. End every run with the report tool: one line on what you found or did, and in needs what you could not do and need from your manager, if anything.\n\n${sp.job}`
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

// The manager's side (Kage's owner sessions, runtime/kage-tools.ts): write, pause, run and remove specialist files.
// The hub syncs right after a change, so run works at once; the minute sync applies it anyway.
export type Manage = { action: 'save' | 'pause' | 'resume' | 'run' | 'remove'; name: string; thread?: string; schedule?: string; tools?: string[]; job?: string; by?: Maker; why?: string }
export function specialistManager(o: { dir: string; max: number; ledgers: { text(name: 'runs' | 'costs' | 'reports'): string }; sync: (now: number) => void; runNow: (id: string, now: number) => string | undefined }) {
  const rows = (now: number) => specialistRows(readSpecialists(o.dir), { runs: o.ledgers.text('runs'), costs: o.ledgers.text('costs'), reports: o.ledgers.text('reports'), now })
  return {
    list(now: number): string {
      const all = rows(now)
      if (!all.length) return 'No specialists yet.'
      return all.map(r => `${rowLine(r, now)}\n  made by ${r.by === 'kage' ? 'Kage' : 'the owner'}${r.why ? `: ${r.why}` : ''}\n  last report: ${resultLine(r, now)}`).join('\n')
    },
    manage(a: Manage, now: number): string {
      if (!NAME.test(a.name)) return `"${a.name}" is not a specialist name: a short lowercase name, letters, digits, dashes.`
      const file = `${o.dir}/${a.name}.md`
      if (a.action === 'pause' || a.action === 'resume') {
        const said = pauseSpecialist(o.dir, a.name, a.action === 'pause')
        o.sync(now)
        return said
      }
      if (!existsSync(file) && a.action !== 'save') return `There is no specialist named "${a.name}".`
      if (a.action === 'remove') { unlinkSync(file); o.sync(now); return `removed ${a.name}: its file and its schedule are gone.` }
      if (a.action === 'run') {
        const r = rows(now).find(x => x.name === a.name)!
        if (r.state !== 'runs') return `${a.name} does not run now: it is ${r.state === 'paused' ? 'paused. Resume it first' : `broken (${r.error})`}.`
        o.sync(now)
        return o.runNow(`spec-${a.name}`, now) ?? `${a.name} is running now. Its report shows in the list when it ends.`
      }
      const old = existsSync(file) ? parseSpecialist(a.name, readFileSync(file, 'utf8')) : undefined
      if (!old && readSpecialists(o.dir).length >= o.max) return `not saved: this install has at most ${o.max} specialists (KAGE_MAX_SPECIALISTS). Remove one first, or ask the owner to raise it.`
      const text = specialistFile({ thread: a.thread ?? '', schedule: a.schedule ?? '', tools: a.tools ?? [], job: a.job ?? '', by: a.by ?? 'kage', why: a.why ?? '', paused: !!old && !('error' in old) && old.paused })
      if (typeof text !== 'string') return `not saved: ${text.error}`
      mkdirSync(o.dir, { recursive: true, mode: 0o700 })
      writeFileSync(`${file}.new`, text, { mode: 0o600 })
      renameSync(`${file}.new`, file)
      o.sync(now)
      return `saved ${a.name}: ${a.schedule}, tools ${(a.tools ?? []).join(', ') || 'none'}. It posts in its thread.`
    },
  }
}

// KAGE_SPECIALIST_DAILY_USD: a specialist whose lane spent the cap today is paused (its file says so) and flagged.
// It stays paused past midnight: a resume is the owner's or the manager's call. Returns who was paused.
export function costCap(dir: string, rows: SpecialistRow[], capUsd: number, flag: (name: string, why: string) => void): string[] {
  const over = rows.filter(r => r.state === 'runs' && r.costToday >= capUsd)
  for (const r of over) {
    pauseSpecialist(dir, r.name, true)
    flag(r.name, `paused: it spent $${r.costToday.toFixed(2)} today, at or over its daily cap of $${capUsd.toFixed(2)} (KAGE_SPECIALIST_DAILY_USD)`)
  }
  return over.map(r => r.name)
}

// The owner's words typed in a specialist's thread (no tag) reach its next run, scheduled or run now. Kept in the
// store, so a restart loses none. Only the owner's: anyone else's words in the thread could steer it.
const NOTES = 'specialist-notes'
export function ownerNotes(store: Pick<Store, 'load' | 'save'>) {
  const all = () => (store.load(NOTES) ?? {}) as Record<string, string[]>
  return {
    // lanes: every specialist's lane key (the grants). Each lane in this thread keeps the last 10.
    wrote(lanes: Iterable<string>, chat: string, thread: string, text: string) {
      const notes = all()
      let hit = false
      for (const k of lanes) if (k.startsWith(`${chat}:${thread}#side-spec-`)) { notes[k] = [...notes[k] ?? [], text.slice(0, 2000)].slice(-10); hit = true }
      if (hit) store.save(NOTES, notes)
    },
    take(key: string): string | undefined {
      const notes = all()
      const mine = notes[key]
      if (!mine?.length) return undefined
      delete notes[key]
      store.save(NOTES, Object.keys(notes).length ? notes : undefined)
      return `The owner wrote in this thread since your last run. Their words to you, to follow within your job and your grant:\n${mine.map(t => t.split('\n').map(l => `> ${l}`).join('\n')).join('\n')}`
    },
  }
}
