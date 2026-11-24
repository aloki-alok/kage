import { existsSync } from 'node:fs'
import { findPeople, type Person } from '../core/gate.ts'
import { add, kindOf, ownerPerson, remove, type Entry, pastedId } from '../core/registry.ts'
import { registryOf, withRegistry } from '../core/config.ts'
import { readSettings, updateConfig } from '../runtime/config-files.ts'
import { pauseLine, type Live } from '../core/board.ts'
import { askHub, DIR, ENV_FILE, settingsExist } from './home.ts'
import { NAME, resultLine, rowLine, kageletRows, starterFile } from '../core/kagelets/kagelet.ts'
import { openLedgers } from '../runtime/ledger.ts'
import { jobPath, kageletsDir, readKagelets, writeJob } from '../runtime/kagelets/files.ts'
import { reload, said } from './reload.ts'
import { outputFlags, printJson } from './output.ts'

const KAGELETS = kageletsDir(DIR)
const die = (msg: string): never => { console.error(msg); process.exit(1) }
const out = outputFlags(process.argv.slice(2))
const [cmd = '', ...args] = out.args.map(pastedId)
const USAGE = 'Usage: kage person add <person> [--trusted | --not-trusted] | kage person add <app id> <owner> | kage person rm <person or app id> | kage person list'
if (!['add', 'remove', 'list'].includes(cmd)) die(USAGE)
if (cmd !== 'list' && process.env.KAGE_CLAUDE) die(`This shell runs inside Kage, and a session cannot change who reaches Kage. The owner runs kage ${cmd} in their own terminal.`)
if (cmd === 'add' && args[0] === 'kagelet') {
  const name = args[1] ?? ''
  if (args.length !== 2 || !NAME.test(name)) die('Usage: kage kagelet add <name>, a short lowercase name: letters, digits, dashes')
  const file = jobPath(KAGELETS, name)
  if (existsSync(`${KAGELETS}/${name}`)) die(`${KAGELETS}/${name} already exists. Edit its job.md, or pick another name.`)
  try { writeJob(KAGELETS, name, starterFile()) } catch (e) { die((e as Error).message) }
  console.log(`Wrote ${file}, paused.\nFill in its thread, schedule, tools and job, then run kage kagelet start ${name}. It runs within a minute.`)
  process.exit(0)
}
if (!settingsExist()) die(`No settings in ${DIR}. Run kage setup first.`)
const { config, secrets } = (() => { try { return readSettings(ENV_FILE) } catch (e) { return die((e as Error).message) } })()
const now = registryOf(config)

async function slack(method: string, params: Record<string, string>) {
  const token = secrets.slack?.user
  if (!token) die(`No Slack user token saved in ${DIR}. Run kage slack save first.`)
  const r = await fetch(`https://slack.com/api/${method}?${new URLSearchParams(params)}`, { headers: { Authorization: `Bearer ${token}` } })
  return await r.json() as { ok: boolean; error?: string } & Record<string, any>
}
const must = async (method: string, params: Record<string, string>) => {
  const j = await slack(method, params)
  return j.ok ? j : die(`Slack says: ${j.error}`)
}
const nameOf = async (id: string) => (await slack('users.info', { user: id }).catch(() => undefined))?.user?.real_name as string | undefined

async function everyone(): Promise<Person[]> {
  const all: Person[] = []
  let cursor = ''
  do {
    const j = await must('users.list', { limit: '200', ...(cursor && { cursor }) })
    all.push(...j.members)
    cursor = j.response_metadata?.next_cursor ?? ''
  } while (cursor)
  return all
}

async function who(query: string): Promise<{ kind: Entry['kind']; id: string; name?: string; tag?: string }> {
  const q = query.trim()
  if (kindOf(q) === 'agent') return { kind: 'agent', id: q }
  if (/^[^\s@<]+@[^\s@>]+\.[^\s@>]+$/.test(q)) {
    const j = await slack('users.lookupByEmail', { email: q })
    if (j.error === 'missing_scope') die('Slack does not let this app look people up by email (it lacks the users:read.email scope). Run kage slack upgrade, or use their @handle, name or member id.')
    if (!j.ok) die(j.error === 'users_not_found' ? `No one in this workspace has the email ${q}.` : `Slack says: ${j.error}`)
    return { kind: 'person', id: j.user.id, name: j.user.real_name }
  }
  const isId = /^<?@?[UW][A-Z0-9]{2,}>?$/.test(q)
  const found = findPeople(isId ? [] : await everyone(), q)
  if (found.length === 0) die(`No active person matches "${query}". Try their @handle, email or Slack member id. An agent is added by its app id.`)
  if (found.length > 1) die(`"${query}" matches more than one person. Run again with one of these ids:\n${found.map(p => `  ${p.id}  ${p.name}`).join('\n')}`)
  const p = found[0]!
  if (!isId) return { kind: 'person', ...p }
  if (cmd === 'remove') return { kind: 'person', id: p.id }
  const u = (await must('users.info', { user: p.id })).user
  if (u.is_bot && kindOf(u.profile?.api_app_id ?? '') === 'agent') return { kind: 'agent', id: u.profile.api_app_id, name: u.real_name, tag: p.id }
  return { kind: 'person', id: p.id, name: u.real_name }
}

const label = (e: { id: string; name?: string }) => (e.name && e.name !== e.id ? `${e.name} (${e.id})` : e.id)
const names = new Map<string, string>()
const line = (e: Entry) => (e.kind === 'person' ? `person ${label({ id: e.id, name: names.get(e.id) })}` : `agent ${e.id}${e.owner ? `, which answers to ${label({ id: e.owner, name: names.get(e.owner) })}` : ''}${e.tag ? `, tagged as ${e.tag}` : ''}`)

async function save(next: Entry[]) {
  updateConfig(ENV_FILE, c => withRegistry(c, next))
  try { for (const l of said(await reload())) console.log(l) } catch (e) { console.log((e as Error).message) }
}

if (cmd === 'list' && out.json) {
  if (args.includes('--kagelets')) {
    const ledgers = openLedgers(DIR)
    printJson(kageletRows(readKagelets(KAGELETS), { runs: ledgers.text('runs'), costs: ledgers.text('costs'), reports: ledgers.text('reports'), now: Date.now() }), out.jq)
    ledgers.close()
  } else {
    for (const e of now) if (e.kind === 'person' && !args.includes('--ids')) { const n = await nameOf(e.id); if (n) names.set(e.id, n) }
    printJson(now.map(e => e.kind === 'person' ? { ...e, name: names.get(e.id) ?? null } : e), out.jq)
  }
} else if (cmd === 'list') {
  const board = await askHub<Live>({ type: 'board' }).catch(() => undefined)
  if (board?.paused) console.log(pauseLine(board.paused))
  const people = !args.includes('--kagelets'), kagelets = !args.includes('--people')
  if (people && !now.length) console.log('No one is listed: only you can tag Kage. Add someone: kage person add <person>')
  if (people && !args.includes('--ids')) for (const e of now) if (e.kind === 'person') { const n = await nameOf(e.id); if (n) names.set(e.id, n) }
  const under = (owner: string, depth: number): void => {
    for (const a of now) if (a.kind === 'agent' && a.owner === owner) { console.log(`${'  '.repeat(depth)}agent ${a.id}${depth === 1 ? `  gets this person's ${now.some(p => p.kind === 'person' && p.id === owner && p.trusted) ? 'trusted' : 'teammate'} access` : ''}${a.tag ? '' : '  (no tag saved, so Kage cannot address it: add it again by a mention of it)'}`); under(a.id, depth + 1) }
  }
  if (people) for (const e of now) if (e.kind === 'person') { console.log(`${label({ id: e.id, name: names.get(e.id) })}${e.trusted ? '  trusted: may use your connectors' : ''}`); under(e.id, 1) }
  const loose = now.filter(e => e.kind === 'agent' && !ownerPerson(now, e.id))
  if (people && loose.length) console.log(`Agents not tied to a listed person: ${loose.map(e => e.id).join(', ')}\n  They may only read and answer. One with no owner counts with any listed person's token. Tie one to its owner: kage person add <app id> <owner>`)
  const files = kagelets ? readKagelets(KAGELETS) : []
  if (files.length) {
    const ledgers = openLedgers(DIR)
    const t = Date.now()
    console.log(`\nKagelets Kage manages (${files.length}):`)
    for (const r of kageletRows(files, { runs: ledgers.text('runs'), costs: ledgers.text('costs'), reports: ledgers.text('reports'), now: t })) console.log(`  ${rowLine(r, t)}${r.state === 'broken' ? '' : `\n    made by ${r.by === 'kage' ? 'Kage' : 'you'}${r.why ? `: ${r.why}` : ''}. Last report: ${resultLine(r, t)}`}`)
    ledgers.close()
  }
} else if (cmd === 'add' && args.some(a => a === '--trusted' || a === '--not-trusted')) {
  const on = args.includes('--trusted'), rest = args.filter(a => a !== '--trusted' && a !== '--not-trusted')
  const person = await who(rest.join(' '))
  if (person.kind !== 'person') die('Only a person can be trusted. Their agents follow them.')
  const listed = add(now, { kind: 'person', id: person.id })
  if ('error' in listed) die(`Not changed: ${listed.error}`)
  const next = ('error' in listed ? now : listed.entries).map(e => (e.kind === 'person' && e.id === person.id ? { kind: 'person' as const, id: e.id, ...on && { trusted: true as const } } : e))
  console.log(on
    ? `${label(person)} is trusted: their tasks, and their agents', may use your claude.ai connectors and other MCP tools. Secrets, your memory, your browser and one-way steps stay as for any teammate.`
    : `${label(person)} is a plain teammate again: your connectors are closed to their tasks.`)
  await save(next)
} else if (cmd === 'add' && args.length) {
  const oneWord = kindOf(args[0]!) === 'agent' || /^<?@?[UW][A-Z0-9]{2,}>?$/.test(args[0]!)
  const first = await who(oneWord ? args[0]! : args.join(' '))
  if (first.name) names.set(first.id, first.name)
  let entry: Entry
  if (first.kind === 'agent') {
    if (args.length < 2) die(`${label(first)} is an agent, and an agent answers to one owner. Run: kage person add ${first.id} <its owner: a person, or a listed agent's app id>`)
    const owner = await who(args.slice(1).join(' '))
    if (owner.name) names.set(owner.id, owner.name)
    entry = { kind: 'agent', id: first.id, owner: owner.id, ...(first.tag && { tag: first.tag }) }
  } else {
    if (oneWord && args.length > 1) die(USAGE)
    entry = { kind: 'person', id: first.id }
  }
  const r = add(now, entry)
  if ('error' in r) die(`Not added: ${r.error}`)
  else if (!r.added.length) console.log(`${line(entry)} is already listed. Nothing changed.`)
  else {
    for (const e of r.added) console.log(`Added ${line(e)}.`)
    if (entry.kind === 'agent') console.log(kindOf(entry.owner!) === 'person'
      ? "A tagged post from this agent, made with its owner's token, counts as that person's task. It never counts as yours."
      : 'An agent that answers to another agent cannot task Kage from Slack yet.')
    await save(r.entries)
  }
} else if (cmd === 'remove' && args.length) {
  const target = await who(args.join(' '))
  const r = remove(now, target.id)
  if (!r.removed.length) console.log(`${label(target)} is not listed. Nothing changed.`)
  else {
    for (const e of r.removed) console.log(`Removed ${line(e)}.`)
    await save(r.entries)
  }
} else die(USAGE)
