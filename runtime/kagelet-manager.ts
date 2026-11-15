// The kagelet manager: the tool Kage's owner sessions use to write, pause, run, remove and revoke kagelets,
// and which tools each one is granted.
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { DEFAULT_MODEL } from '../core/config.ts'
import { chainErrors, COST_FLAG, DB_READ, NAME, parseKagelet, resultLine, revokeStanding, rowLine, kageletFile, kageletRows, type Kagelet, type Standing } from '../core/kagelets.ts'
import { chainLine, chainViews } from '../core/events.ts'
import { kageletTier } from '../core/access.ts'
import type { Store } from './store.ts'
import type { Ledgers } from './ledger.ts'
import { pauseKagelet, readKagelets } from './kagelet-files.ts'

// The command a kagelet's db_read runs: kagelets.dbRead.command wins, else the one this kagelet saved with.
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
export type Manage = { action: 'save' | 'pause' | 'resume' | 'run' | 'remove' | 'revoke'; name: string; thread?: string; schedule?: string; after?: string; tools?: string[]; job?: string; why?: string; model?: string; model_why?: string; read_command?: string }
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
      return [...all.map(r => `${rowLine(r, now)}\n  model ${r.model}${r.modelWhy ? `: ${r.modelWhy}` : ''}\n  made by ${r.by === 'kage' ? 'Kage' : 'the owner'}${r.why ? `: ${r.why}` : ''}\n  last report: ${resultLine(r, now)}${flags.has(r.name) ? `\n  cost flag today: ${flags.get(r.name)}` : ''}`),
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
        // Its read command stays: the owner approved it for the install, and no card can bring one back.
        unlinkSync(file)
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
      if (!old && readKagelets(o.dir).length >= o.max) return refuse(`this install has at most ${o.max} kagelets (kagelets.max). Remove one first, or ask the owner to raise it.`)
      // after: refused when it names a missing kagelet, closes a cycle or goes too deep, with this file in place.
      const others = readKagelets(o.dir).filter(f => f.name !== a.name).map(f => parseKagelet(f.name, f.text)).filter((p): p is Kagelet => !('error' in p))
      // Also refused when it breaks a step after it (a tool taken away that the next step holds).
      const errors = chainErrors([...others, { name: a.name, ...(a.after && { after: a.after }), tools }])
      const chained = errors.get(a.name) ?? [...errors].find(([n]) => others.some(x => x.name === n && x.after === a.name))?.[1]
      if (chained) return refuse(chained)
      // Who made it is what the hub knows: a file that exists keeps its maker (a hand-written one is the owner's),
      // and a new one is Kage's, since only Kage's tool writes it.
      const by = had ? had.by : 'kage'
      // The model stays as the file has it. One Kage picks, past the default, needs a reason the panel shows.
      const model = a.model ?? had?.model ?? DEFAULT_MODEL
      const modelWhy = a.model_why ?? (model === had?.model ? had.modelWhy : '')
      if (model !== DEFAULT_MODEL && model !== had?.model && !modelWhy.trim()) return refuse(`${model} needs a one-line model_why: the owner sees it in the panel`)
      const fileText = (approved: boolean, standing: string[] = []) => kageletFile({ thread: a.thread ?? '', schedule: a.schedule ?? '', ...(a.after && { after: a.after }), tools, job: a.job ?? '', by, why: a.why ?? '', model, modelWhy, paused: !!had?.paused, approved, standing })
      // Checked as if approved first, so an act tool or a file that would not run is refused before any card.
      const valid = fileText(true)
      if (typeof valid !== 'string') return refuse(valid.error)
      // db_read reads through a command the install already has: kagelets.dbRead.command, else one the owner approved
      // before (kept in the store). A kagelet never brings a new one.
      let command: string | undefined
      if (tools.includes(DB_READ) && !o.envCommand) {
        const known = [...new Set([...Object.values(commands(o.store)), o.store.load(OLD_READ_COMMAND) as string | undefined].filter((c): c is string => !!c))]
        command = a.read_command?.trim() || commands(o.store)[a.name] || (known.length === 1 ? known[0] : undefined)
        if (!known.length) return refuse(`${DB_READ} reads through the install's read command, and none is set: the owner sets kagelets.dbRead.command`)
        if (!command) return refuse(`${DB_READ}: pass read_command, one of the install's read commands`)
        if (!known.includes(command)) return refuse(`a kagelet never gets a read command the install does not already have: the owner sets kagelets.dbRead.command`)
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
