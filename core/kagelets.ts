import { DEFAULT_MODEL, MODELS } from './config.ts'
import { nextRun, parseCron } from './cron.ts'
import { slackLinkKey } from './conversations.ts'
import { clockTime, whenLabel } from './board.ts'
import { spendSince } from './ledgers.ts'
import { CAP_PAUSE } from './kagelet-view.ts'
import { ALL, DB_READ, kageletTier } from './access.ts'
import { heldCommand } from './held.ts'
import { allowedBy, badRule } from './held-rules.ts'
import { objectiveOf, type Objective } from './objective.ts'
import { idLine } from './kagelet-people.ts'

export { DB_READ }

export const NAME = /^(?!memory$)[a-z][a-z0-9-]{0,30}$/

type Maker = 'owner' | 'kage'
export type Kagelet = { name: string; key: string; link: string; cron: string; after?: string; tools: string[]; job: string; paused: boolean; by: Maker; why: string; model: string; modelWhy: string; resumed?: number; standing?: string[]; objective?: Objective; allow?: string[]; people?: string[]; owners?: string[] }

const MODEL = new RegExp(`^(${MODELS.join('|')}|claude-[a-z0-9.-]+(\\[1m\\])?)$`)

export function parseKagelet(name: string, text: string): Kagelet | { error: string } {
  if (!NAME.test(name)) return { error: `the file name "${name}" must be a short lowercase name: letters, digits, dashes` }
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text.replace(/\r\n/g, '\n'))
  if (!m) return { error: 'it needs front matter between --- lines: thread, schedule, tools' }
  const head = new Map(m[1]!.split('\n').map(l => /^(\w+):\s*(.*)$/.exec(l.trim())).filter(x => !!x).map(x => [x[1]!, x[2]!.trim()]))
  const link = head.get('thread') ?? ''
  const thread = slackLinkKey(link)
  if (!thread) return { error: 'thread must be a Slack message link ("Copy link" in Slack)' }
  const cron = head.get('schedule') ?? ''
  const after = head.get('after') ?? ''
  if (after && !NAME.test(after)) return { error: `after must name a kagelet, not "${after}"` }
  if (cron || !after) try { parseCron(cron) } catch { return { error: `schedule must be a cron line like "0 9 * * 1-5", not "${cron}"` } }
  const model = head.get('model') || DEFAULT_MODEL
  if (!MODEL.test(model)) return { error: `model must be sonnet, opus, haiku, fable or a claude-... id, not "${model}"` }
  const job = m[2]!.trim()
  if (!job) return { error: 'the job, below the front matter, is empty' }
  const tools = (head.get('tools') ?? '').split(',').map(t => t.trim()).filter(Boolean)
  const standing = (head.get('standing') ?? '').split(',').map(t => t.trim()).filter(t => tools.includes(t))
  const act = tools.find(t => kageletTier(t) === 'act')
  if (act) return { error: `a kagelet never holds ${act}: it is an act tool (prod, money, customers, access or a delete) or not a web or MCP tool. The kagelet says in its thread what it needs, and Kage asks the owner each time.` }
  const objective = objectiveOf(head)
  if (objective && 'error' in objective) return objective
  const allow = m[1]!.split('\n').flatMap(l => /^allow:\s*(.*)$/.exec(l.trim())?.slice(1, 2) ?? []).map(r => r.trim())
  const bad = allow.find(badRule)
  if (bad !== undefined) return { error: `allow must start with the command it releases, not "${bad}"` }
  const people = idLine(m[1]!, head, 'people'), owners = idLine(m[1]!, head, 'owners')
  if ('error' in people) return people
  if ('error' in owners) return owners
  return { name, key: `${thread}#side-kagelet-${name}`, link, cron, ...(after && { after }), tools, job, paused: isPaused(head.get('paused')),
    by: head.get('by') === 'kage' ? 'kage' : 'owner', why: head.get('why') ?? '', model, modelWhy: head.get('model_why') ?? '',
    ...(Date.parse(head.get('resumed') ?? '') >= 0 && { resumed: Date.parse(head.get('resumed')!) }), ...(standing.length && { standing }), ...(objective && { objective }), ...(allow.length && { allow }), ...(people.length && { people }), ...(owners.length && { owners }) }
}

const isPaused = (v = '') => !['', 'no', 'false'].includes(v.toLowerCase())

export function addAllow(text: string, command: string): string | undefined {
  const rule = command.trim()
  if (/[\r\n*'"\\]/.test(rule) || badRule(rule) || allowedBy([rule], rule) !== rule) return undefined
  const m = /^(---\r?\n)([\s\S]*?\r?\n)(---)/.exec(text)
  if (!m) return undefined
  if (m[2]!.split(/\r?\n/).some(l => l.trim() === `allow: ${rule}`)) return text
  return `${m[1]}${m[2]}allow: ${rule}\n${text.slice(m[1]!.length + m[2]!.length)}`
}

export function setPaused(text: string, paused: boolean, now?: number) {
  const m = /^(---\r?\n)([\s\S]*?\r?\n)(---)/.exec(text)
  if (!m) return text
  if (!paused && !/^\s*paused:/m.test(m[2]!)) return text
  let head = m[2]!.replace(/^\s*paused:.*\r?\n/gm, '')
  if (!paused && now !== undefined) head = `${head.replace(/^\s*resumed:.*\r?\n/gm, '')}resumed: ${new Date(now).toISOString()}\n`
  return `${m[1]}${head}${paused ? 'paused: yes\n' : ''}${text.slice(m[1]!.length + m[2]!.length)}`
}

export const starterFile = () => `---
thread: paste the Slack link of the thread it posts in ("Copy link" on a message there)
schedule: 0 9 * * 1-5
tools: WebSearch, WebFetch
paused: yes
---
Say what to check, where, and what to post in the thread. For example: every weekday at 9, read https://status.example.com and post a three-line summary.
`

export function kageletFile(f: { thread: string; schedule: string; after?: string; tools: string[]; job: string; by: Maker; why: string; model?: string; modelWhy?: string; paused?: boolean; resumed?: number; approved?: boolean; standing?: string[]; objective?: Objective; allow?: string[]; people?: string[]; owners?: string[] }): string | { error: string } {
  for (const [k, v] of Object.entries({ thread: f.thread, schedule: f.schedule, after: f.after ?? '', why: f.why, model: f.model ?? '', model_why: f.modelWhy ?? '', tool: f.tools.join(','), objective: f.objective?.objective ?? '', measure: f.objective?.measure ?? '', allow: (f.allow ?? []).join(''), people: (f.people ?? []).join(','), owners: (f.owners ?? []).join(',') })) if (/[\r\n]/.test(v)) return { error: `the ${k} must be one line` }
  const odd = f.tools.find(t => !/^[\w-]+$/.test(t))
  if (odd) return { error: `"${odd}" is not one tool name: letters, digits, _ and - only` }
  const wide = !f.approved && f.tools.find(t => kageletTier(t) === 'write')
  if (wide) return { error: `${wide} needs the owner's yes on Kage's card: it sends or changes something` }
  const standing = (f.standing ?? []).filter(t => f.tools.includes(t))
  const text = `---\nthread: ${f.thread}\n${f.schedule || !f.after ? `schedule: ${f.schedule}\n` : ''}${f.after ? `after: ${f.after}\n` : ''}tools: ${f.tools.join(', ')}\nby: ${f.by}\nwhy: ${f.why}\n${f.model && f.model !== DEFAULT_MODEL ? `model: ${f.model}\n${f.modelWhy ? `model_why: ${f.modelWhy}\n` : ''}` : ''}${standing.length ? `standing: ${standing.join(', ')}\n` : ''}${f.objective ? `objective: ${f.objective.objective}\nmeasure: ${f.objective.measure}\ntarget: ${f.objective.target.op} ${f.objective.target.n}\n` : ''}${(f.allow ?? []).map(r => `allow: ${r}\n`).join('')}${f.people?.length ? `people: ${f.people.join(', ')}\n` : ''}${f.owners?.length ? `owners: ${f.owners.join(', ')}\n` : ''}${f.paused ? 'paused: yes\n' : f.resumed !== undefined ? `resumed: ${new Date(f.resumed).toISOString()}\n` : ''}---\n${f.job.trim()}\n`
  const sp = parseKagelet('check', text)
  return 'error' in sp ? sp : text
}

export const MAX_CHAIN = 5
export function chainErrors(ks: { name: string; after?: string; tools?: string[] }[]): Map<string, string> {
  const after = new Map(ks.map(k => [k.name, k.after]))
  const tools = new Map(ks.map(k => [k.name, k.tools ?? []]))
  const errors = new Map<string, string>()
  for (const k of ks) {
    if (!k.after) continue
    const before = tools.get(k.after)
    const wider = before && (k.tools ?? []).find(t => !covers(before, t))
    if (wider) { errors.set(k.name, `${k.name} holds ${wider}, which ${k.after} does not: a step holds only tools the one before it holds`); continue }
    const seen = [k.name]
    for (let at = k.after; at; at = after.get(at)!) {
      if (!after.has(at)) { errors.set(k.name, `after names no kagelet named "${at}"`); break }
      if (seen.includes(at)) { errors.set(k.name, `after makes a cycle: ${[...seen, at].join(' after ')}`); break }
      seen.push(at)
    }
    if (!errors.has(k.name) && seen.length > MAX_CHAIN) errors.set(k.name, `this chain is ${seen.length} steps deep, more than ${MAX_CHAIN}`)
  }
  return errors
}

export type Report = { at: number; summary: string; needs?: string }
export type KageletRow = { name: string; state: 'runs' | 'paused' | 'broken'; error?: string; key?: string; link?: string; cron?: string; after?: string; tools: string[]; lastRun?: number; next?: number; costToday: number; avg7: number; result?: Report; by?: Maker; why?: string; model?: string; modelWhy?: string; standing?: string[] }
export function kageletRows(files: { name: string; text: string }[], o: { runs: string; costs: string; reports?: string; now: number }): KageletRow[] {
  const results = new Map<string, Report>()
  for (const l of (o.reports ?? '').split('\n')) {
    const [when = '', name = '', summary = '', needs = ''] = l.split('\t')
    if (name) results.set(name, { at: Date.parse(when), summary, ...(needs && { needs }) })
  }
  const midnight = new Date(o.now).setHours(0, 0, 0, 0)
  const today = spendSince(o.costs, midnight), week = spendSince(o.costs, new Date(midnight).setDate(new Date(midnight).getDate() - 7))
  const last = new Map<string, number>()
  for (const l of o.runs.split('\n')) {
    const [when = '', id = ''] = l.split('\t')
    const name = id.startsWith('kagelet-') ? id.slice(8) : ''
    if (name) last.set(name, Date.parse(when))
  }
  const chained = chainErrors(files.map(f => parseKagelet(f.name, f.text)).filter((p): p is Kagelet => !('error' in p)))
  return [...files].sort((a, b) => a.name.localeCompare(b.name)).map((f): KageletRow => {
    const parsed = parseKagelet(f.name, f.text)
    const sp = !('error' in parsed) && chained.has(parsed.name) ? { error: chained.get(parsed.name)! } : parsed
    if ('error' in sp) return { name: f.name, state: 'broken', error: sp.error, tools: [], costToday: 0, avg7: 0 }
    const next = sp.paused || !sp.cron ? undefined : nextRun(sp.cron, new Date(o.now), 366 * 24 * 3600_000)?.getTime()
    return {
      name: sp.name, state: sp.paused ? 'paused' : 'runs', key: sp.key, link: sp.link, cron: sp.cron, ...(sp.after && { after: sp.after }), tools: sp.tools,
      ...(last.has(sp.name) && { lastRun: last.get(sp.name) }), ...(next !== undefined && { next }), costToday: spendSince(o.costs, Math.max(midnight, sp.resumed ?? 0)).find(s => s.key === sp.key)?.usd ?? 0,
      avg7: Math.round(((week.find(s => s.key === sp.key)?.usd ?? 0) - (today.find(s => s.key === sp.key)?.usd ?? 0)) / 7 * 1e6) / 1e6,
      ...(results.has(sp.name) && { result: results.get(sp.name) }), by: sp.by, why: sp.why, model: sp.model, modelWhy: sp.modelWhy, ...(sp.standing && { standing: sp.standing }),
    }
  })
}

export function rowLine(r: KageletRow, now: number) {
  if (r.state === 'broken') return `${r.name.padEnd(16)} does not run: ${r.error}`
  return [r.name.padEnd(16), r.state.padEnd(6), (r.cron || `after ${r.after}`).padEnd(15), `last ${r.lastRun ? clockTime(r.lastRun, now) : 'never'}`.padEnd(14),
    `next ${whenLabel(r.next, now)}`.padEnd(14), `$${r.costToday.toFixed(2)} today, avg $${r.avg7.toFixed(2)}`].join(' ')
}

export const resultLine = (r: KageletRow, now: number) => !r.result ? 'no report yet'
  : `${clockTime(r.result.at, now)} ${r.result.needs ? `needs: ${r.result.needs} (${r.result.summary})` : r.result.summary}`

const THREAD_TOOLS = [...['reply', 'edit_message', 'delete_message', 'report', 'message_kagelet', 'propose_memory'].map(t => `mcp__kage__${t}`), 'ToolSearch']
const WEB_TOOLS = ['WebFetch', 'WebSearch']
export const shellGrant = (grant: string[] | undefined) => !!grant?.includes(ALL)
export const covers = (grant: string[], tool: string) => grant.includes(tool) || (shellGrant(grant) && !tool.startsWith('mcp__') && tool !== DB_READ)
export const builtinTools = (grant: string[]) => shellGrant(grant) ? undefined : [...grant.filter(t => WEB_TOOLS.includes(t)), 'ToolSearch']
export const laneOptions = (grant: string[]) => shellGrant(grant) ? { settingSources: [] } : { tools: builtinTools(grant)! }

export function grantRefusal(tool: string, grant: string[], input: Record<string, unknown> = {}, allow: string[] = []) {
  if (THREAD_TOOLS.includes(tool)) return undefined
  if (tool === 'WebFetch' && !/^https?:\/\//i.test(String(input.url ?? ''))) return 'A kagelet fetches only http and https addresses.'
  if (shellGrant(grant) && !tool.startsWith('mcp__')) {
    const command = String(input.command ?? '')
    const held = tool === 'Bash' && !allowedBy(allow, command) ? heldCommand(command) : undefined
    return held && `Held: ${held} is a one-way step. Do not try it another way. Put the exact step and why in your report's needs: your manager decides.`
  }
  if (tool === `mcp__kage__${DB_READ}`) return grant.includes(DB_READ) ? undefined : `${DB_READ} is outside this kagelet's grant. Say in the thread what you needed: your manager decides.`
  if (kageletTier(tool) === 'act') return `A kagelet never holds ${tool}, whatever its grant says. Say in the thread what you needed: your manager asks the owner.`
  return grant.includes(tool) ? undefined
    : `${tool} is outside this kagelet's grant (${grant.join(', ') || 'no tools'}). Say in the thread what you needed: your manager decides.`
}

export type Standing = Record<string, number>

export function revokeStanding(files: { name: string; text: string }[], tool: string): { name: string; text: string }[] {
  return files.flatMap(f => {
    const k = parseKagelet(f.name, f.text)
    if ('error' in k || !k.standing?.includes(tool)) return []
    const left = k.standing.filter(t => t !== tool)
    const text = f.text.replace(/^[ \t]*standing:.*\r?\n/m, left.length ? `standing: ${left.join(', ')}\n` : '').replace(/^[ \t]*tools:.*$/m, `tools: ${k.tools.filter(t => t !== tool).join(', ')}`)
    return [{ name: f.name, text }]
  })
}

export type Caps = { each?: number; total?: number }
const usd = (n: number) => `$${n.toFixed(2)}`
const spentToday = (rows: KageletRow[]) => Math.round(rows.reduce((s, r) => s + r.costToday, 0) * 1e6) / 1e6

export function capCheck(rows: KageletRow[], caps: Caps, sent: string[], title: string) {
  const runs = rows.filter(r => r.state === 'runs')
  const total = spentToday(rows)
  const allOver = runs.length > 0 && caps.total !== undefined && total >= caps.total
  const pause: { name: string; why: string }[] = []
  const tell: { id?: string; text: string }[] = []
  for (const r of runs) {
    if (caps.each !== undefined && r.costToday >= caps.each) {
      const why = `${CAP_PAUSE} ${usd(r.costToday)} today, at or over its daily cap of ${usd(caps.each)} (kagelets.dailyUsd)`
      pause.push({ name: r.name, why })
      tell.push({ text: `Kagelet *${r.name}* is ${why}. Resume it with kage top or by asking ${title}.` })
    } else if (allOver) pause.push({ name: r.name, why: `${CAP_PAUSE} ${usd(r.costToday)} today, and all kagelets together spent ${usd(total)}, at or over the total daily cap of ${usd(caps.total!)} (kagelets.totalDailyUsd)` })
    else if (caps.each !== undefined && r.costToday >= 0.8 * caps.each) tell.push({ id: r.name, text: `Kagelet *${r.name}* spent ${usd(r.costToday)} today, 80% of its daily cap of ${usd(caps.each)}. At the cap it pauses.` })
  }
  if (allOver) tell.push({ id: 'total', text: `Every kagelet is paused: together they spent ${usd(total)} today, at or over the total daily cap of ${usd(caps.total!)} (kagelets.totalDailyUsd). A cap raise is yours, in the settings file.` })
  else if (runs.length && caps.total !== undefined && total >= 0.8 * caps.total) tell.push({ id: 'total-80', text: `Kagelets together spent ${usd(total)} today, 80% of the total daily cap of ${usd(caps.total)}. At the cap every kagelet pauses.` })
  return { pause, tell: tell.filter(t => !t.id || !sent.includes(t.id)) }
}

export function budgetLeft(rows: KageletRow[], key: string, caps: Caps): number | undefined {
  const left = [caps.each === undefined ? Infinity : caps.each - (rows.find(r => r.key === key)?.costToday ?? 0), caps.total === undefined ? Infinity : caps.total - spentToday(rows)]
  return caps.each === undefined && caps.total === undefined ? undefined : Math.max(0.01, Math.round(Math.min(...left) * 100) / 100)
}

export const COST_FLAG = 'cost:'
const SPIKE_FLOOR = 0.5
export function costFlags(rows: KageletRow[], l: { runs: string; costs: string; reports: string }, now: number): { name: string; line: string }[] {
  const midnight = new Date(now).setHours(0, 0, 0, 0)
  const tsv = (t: string) => t.split('\n').filter(Boolean).map(x => x.split('\t'))
  const said = new Set(tsv(l.reports).filter(([at = '']) => Date.parse(at) >= midnight).map(([, n = '']) => n))
  return rows.flatMap(r => {
    if (!r.key || said.has(`${COST_FLAG}${r.name}`)) return []
    const why: string[] = []
    if (r.costToday > SPIKE_FLOOR && r.costToday > 3 * r.avg7) why.push(`spent ${usd(r.costToday)} today, over 3x its 7-day average of ${usd(r.avg7)}`)
    const starts = tsv(l.runs).filter(([at = '', id]) => id === `kagelet-${r.name}` && Date.parse(at) >= midnight).map(([at]) => Date.parse(at!))
    const costAt = tsv(l.costs).filter(([, k]) => k === r.key).map(([at]) => Date.parse(at!))
    const bare = starts.filter((at, i) => {
      const end = starts[i + 1] ?? Infinity
      return (end !== Infinity || now - at >= 3_600_000) && !costAt.some(c => c >= at && c < end)
    })
    if (bare.length) why.push(`its ${bare.map(at => clockTime(at, now)).join(', ')} run${bare.length > 1 ? 's' : ''} wrote no costs row`)
    return why.length ? [{ name: r.name, line: `${r.name}: ${why.join(', and ')}` }] : []
  })
}
