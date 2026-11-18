import { readFileSync, unlinkSync } from 'node:fs'
import { DEFAULT_MODEL } from '../core/config.ts'
import { chainErrors, COST_FLAG, DB_READ, NAME, parseKagelet, resultLine, revokeStanding, rowLine, kageletFile, kageletRows, type Kagelet, type Standing } from '../core/kagelets.ts'
import { chainLine, chainViews } from '../core/events.ts'
import { ALL, kageletTier } from '../core/access.ts'
import { objectiveOf } from '../core/objective.ts'
import type { Store } from './store.ts'
import type { Ledgers } from './ledger.ts'
import { folderFree, hasKagelet, jobPath, pauseKagelet, readKagelets, writeJob } from './kagelet-files.ts'

const READ_COMMANDS = 'db-read-commands'
const OLD_READ_COMMAND = 'db-read-command'
const STANDING = 'standing-approvals'
const commands = (store: Pick<Store, 'load'>) => (store.load(READ_COMMANDS) ?? {}) as Record<string, string>
export const readCommand = (envCommand: string | undefined, store: Pick<Store, 'load'>, kagelet: string) =>
  envCommand || commands(store)[kagelet] || (store.load(OLD_READ_COMMAND) as string | undefined)
const standings = (store: Pick<Store, 'load'>) => (store.load(STANDING) ?? {}) as Standing

export const OWNERS_HOME = 'owners'
const HOME_STANDIN = 'https://kage.slack.com/archives/C0HOME00/p1000000000000000'
export type AskOwner = (card: { kagelet: string; tools: string; job: string; measure?: string; people?: string; owners?: string }) => Promise<boolean>

export type Manage = { action: 'save' | 'pause' | 'resume' | 'run' | 'remove' | 'revoke'; name: string; thread?: string; schedule?: string; after?: string; tools?: string[]; job?: string; why?: string; model?: string; model_why?: string; read_command?: string; objective?: string; measure?: string; target?: string; people?: string[]; owners?: string[] }
export function kageletManager(o: { dir: string; max: number; ledgers: { text(name: 'runs' | 'costs' | 'reports'): string } & Pick<Ledgers, 'add' | 'events'>; sync: (now: number) => void; runNow: (id: string, now: number) => string | undefined; store: Pick<Store, 'load' | 'save'>; envCommand?: string; log: (line: string) => void
  measures?: { approved: (name: string) => string | undefined; approve: (name: string, command: string) => string | undefined; forget: (name: string) => void }
  openHome?: (owners: string[], name: string) => Promise<string>
  ownersMax?: number
}) {
  if (typeof (o.store.load(STANDING) as { tool?: unknown } | undefined)?.tool === 'string') o.store.save(STANDING, undefined)
  const rows = (now: number) => kageletRows(readKagelets(o.dir), { runs: o.ledgers.text('runs'), costs: o.ledgers.text('costs'), reports: o.ledgers.text('reports'), now })
  const row = (name: string, status: string, why: string, tools: string[]) => o.ledgers.add('grants', [name, status, why, tools.join(', ')])
  return {
    list(now: number): string {
      const all = rows(now)
      if (!all.length) return 'No kagelets yet.'
      const midnight = new Date(now).setHours(0, 0, 0, 0)
      const flags = new Map(o.ledgers.text('reports').split('\n').map(l => l.split('\t')).filter(([at = '', n = '']) => n.startsWith(COST_FLAG) && Date.parse(at) >= midnight).map(([, n, line]) => [n!.slice(COST_FLAG.length), line!]))
      const chains = chainViews(o.ledgers.events(new Date(now).toISOString().slice(0, 10))).map(c => `  ${chainLine(c)}`)
      return [...all.map(r => `${rowLine(r, now)}\n  model ${r.model}${r.modelWhy ? `: ${r.modelWhy}` : ''}\n  made by ${r.by === 'kage' ? 'Kage' : 'the owner'}${r.why ? `: ${r.why}` : ''}\n  last report: ${resultLine(r, now)}${flags.has(r.name) ? `\n  cost flag today: ${flags.get(r.name)}` : ''}`),
        ...chains.length ? [`Chains today:\n${chains.join('\n')}`] : []].join('\n')
    },
    async manage(a: Manage, now: number, ask?: AskOwner): Promise<string> {
      if (a.action === 'revoke') {
        const tool = a.name
        const yes = standings(o.store)
        const out = revokeStanding(readKagelets(o.dir), tool)
        if (!out.length && yes[tool] === undefined) return `There is no standing approval for ${tool}.`
        for (const f of out) {
          writeJob(o.dir, f.name, f.text)
          row(f.name, 'revoked', 'the owner revoked its standing approval', [tool])
          o.log(`kagelet ${f.name}: ${tool} revoked with the standing approval`)
        }
        const { [tool]: _, ...rest } = yes
        o.store.save(STANDING, Object.keys(rest).length ? rest : undefined)
        o.sync(now)
        return `revoked the standing approval for ${tool}. ${out.length ? `It no longer grants it to ${out.map(f => f.name).join(', ')}.` : 'No kagelet held it by that approval.'} The next kagelet that asks for it asks the owner on a card.`
      }
      if (!NAME.test(a.name)) return `"${a.name}" is not a kagelet name: a short lowercase name, letters, digits, dashes.`
      const file = jobPath(o.dir, a.name)
      if (a.action === 'pause' || a.action === 'resume') {
        const said = pauseKagelet(o.dir, a.name, a.action === 'pause', now)
        o.sync(now)
        return said
      }
      if (!hasKagelet(o.dir, a.name) && a.action !== 'save') return `There is no kagelet named "${a.name}".`
      if (a.action === 'remove') {
        unlinkSync(file)
        o.measures?.forget(a.name)
        o.sync(now)
        return `removed ${a.name}: its file and its schedule are gone.`
      }
      if (a.action === 'run') {
        const r = rows(now).find(x => x.name === a.name)!
        if (r.state !== 'runs') return `${a.name} does not run now: it is ${r.state === 'paused' ? 'paused. Resume it first' : `broken (${r.error})`}.`
        if (!r.cron && r.after) return `${a.name} runs only after ${r.after}: run ${r.after} now, and ${a.name} runs when it ends.`
        o.sync(now)
        return o.runNow(`kagelet-${a.name}`, now) ?? `${a.name} is running now. Its report shows in the list when it ends.`
      }
      const tools = a.tools ?? []
      const old = hasKagelet(o.dir, a.name) ? parseKagelet(a.name, readFileSync(file, 'utf8')) : undefined
      const had = old && !('error' in old) ? old : undefined
      const fresh = tools.filter(t => !had?.tools.includes(t))
      const refuse = (why: string) => {
        if (fresh.length) { row(a.name, 'refused', why, fresh); o.log(`kagelet ${a.name}: ${fresh.join(', ')} refused: ${why}`) }
        return `not saved: ${why}`
      }
      if (!folderFree(o.dir, a.name)) return refuse(`${o.dir}/${a.name} is not a plain folder, so no kagelet is written there`)
      if (!old && readKagelets(o.dir).length >= o.max) return refuse(`this install has at most ${o.max} kagelets (kagelets.max). Remove one first, or ask the owner to raise it.`)
      const ownersMax = o.ownersMax ?? 3
      if ((a.owners ?? had?.owners ?? []).length > ownersMax) return refuse(`this install lets a kagelet have at most ${ownersMax} owners (kagelets.ownersMax)`)
      const homePending = a.thread === OWNERS_HOME
      if (homePending && !o.openHome) return refuse('this hub cannot open a home: give a Slack thread link')
      if (homePending) a = { ...a, thread: HOME_STANDIN }
      const others = readKagelets(o.dir).filter(f => f.name !== a.name).map(f => parseKagelet(f.name, f.text)).filter((p): p is Kagelet => !('error' in p))
      const errors = chainErrors([...others, { name: a.name, ...(a.after && { after: a.after }), tools }])
      const chained = errors.get(a.name) ?? [...errors].find(([n]) => others.some(x => x.name === n && x.after === a.name))?.[1]
      if (chained) return refuse(chained)
      const by = had ? had.by : 'kage'
      const model = a.model ?? had?.model ?? DEFAULT_MODEL
      const modelWhy = a.model_why ?? (model === had?.model ? had.modelWhy : '')
      if (model !== DEFAULT_MODEL && model !== had?.model && !modelWhy.trim()) return refuse(`${model} needs a one-line model_why: the owner sees it in the panel`)
      const goal = a.objective || a.measure || a.target ? objectiveOf(new Map(Object.entries({ objective: a.objective ?? '', measure: a.measure ?? '', target: a.target ?? '' }))) : had?.objective
      if (goal && 'error' in goal) return refuse(goal.error)
      const measure = goal && o.measures?.approved(a.name) !== goal.measure ? goal.measure : undefined
      const fileText = (approved: boolean, standing: string[] = []) => kageletFile({ thread: a.thread ?? '', schedule: a.schedule ?? '', ...(a.after && { after: a.after }), tools, job: a.job ?? '', by, why: a.why ?? '', model, modelWhy, paused: !!had?.paused, ...(had?.resumed !== undefined && { resumed: had.resumed }), approved, standing, ...(goal && { objective: goal }), ...(had?.allow && { allow: had.allow }), ...((a.people ?? had?.people) && { people: a.people ?? had!.people }), ...((a.owners ?? had?.owners) && { owners: a.owners ?? had!.owners }) })
      const valid = fileText(true)
      if (typeof valid !== 'string') return refuse(valid.error)
      let command: string | undefined
      if (tools.includes(DB_READ) && !o.envCommand) {
        const known = [...new Set([...Object.values(commands(o.store)), o.store.load(OLD_READ_COMMAND) as string | undefined].filter((c): c is string => !!c))]
        command = a.read_command?.trim() || commands(o.store)[a.name] || (known.length === 1 ? known[0] : undefined)
        if (!known.length) return refuse(`${DB_READ} reads through the install's read command, and none is set: the owner sets kagelets.dbRead.command`)
        if (!command) return refuse(`${DB_READ}: pass read_command, one of the install's read commands`)
        if (!known.includes(command)) return refuse(`a kagelet never gets a read command the install does not already have: the owner sets kagelets.dbRead.command`)
      }
      const yes = standings(o.store)
      const writes = tools.filter(t => kageletTier(t) === 'write')
      const kept = writes.filter(t => had?.tools.includes(t) && !had.standing?.includes(t) && (t !== ALL || had.job.trim() === (a.job ?? '').trim()))
      const standing = writes.filter(t => t !== ALL && !kept.includes(t) && yes[t] !== undefined)
      const card = writes.filter(t => !kept.includes(t) && yes[t] === undefined), stands = card.filter(t => t !== ALL)
      const people = a.people ?? had?.people ?? [], moved = !!had && (a.thread ?? '') !== had.link
      const newPeople = people.filter(p => moved || !had?.people?.includes(p)).join(', ')
      const owners = a.owners ?? had?.owners ?? [], newOwners = owners.filter(p => moved || !had?.owners?.includes(p)).join(', ')
      const extra = [...measure ? [`the measure ${measure}`] : [], ...newPeople ? [`asks from ${newPeople}`] : [], ...newOwners ? [`owners ${newOwners}`] : []]
      const asked = [...card, ...standing.filter(t => fresh.includes(t)), ...extra].join(', ')
      if (asked && !ask) return refuse(`only the owner grants ${asked}, and this session cannot ask them`)
      if ((card.length || extra.length) && !await ask!({ kagelet: a.name, tools: card.join(', '), job: (a.job ?? '').trim().split('\n')[0]!.slice(0, 300), ...measure && { measure }, ...newPeople && { people: newPeople }, ...newOwners && { owners: newOwners } })) return refuse(`the owner did not approve ${[...card, ...extra].join(', ')}`)
      const unpinned = measure && (o.measures ? o.measures.approve(a.name, measure) : 'this hub runs no measures')
      if (unpinned) return refuse(unpinned)
      if (homePending && typeof fileText(true, standing) === 'string') {
        try { a = { ...a, thread: await o.openHome!(a.owners ?? had?.owners ?? [], a.name) } } catch (e) { return refuse(`could not open its home: ${(e as Error).message}`) }
      }
      const text = fileText(true, standing)
      if (typeof text !== 'string') return refuse(text.error)
      if (stands.length) o.store.save(STANDING, { ...yes, ...Object.fromEntries(stands.map(t => [t, now])) })
      if (command) o.store.save(READ_COMMANDS, { ...commands(o.store), [a.name]: command })
      writeJob(o.dir, a.name, text)
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
