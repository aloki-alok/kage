// Kagelets (#57): one file each in the kagelets folder, run on a schedule in a side lane of its thread, at
// teammate trust, with only the tools its grant names. A kagelet approves nothing: what needs approval it says in
// its thread, where its manager (this Kage) and the human owner read it.
import { nextRun, parseCron } from './cron.ts'
import { slackLinkKey } from './conversations.ts'
import { clockTime, whenLabel } from './board.ts'
import { spendSince } from './ledgers.ts'
import { CAP_PAUSE } from './kagelet-view.ts'

// A kagelet's name, which is also its file name: no dots or slashes, so it never leaves the folder.
export const NAME = /^[a-z][a-z0-9-]{0,30}$/

// Who made it, from its file: the owner (by hand, or by asking Kage) or Kage on its own. A hand-written file is the owner's.
export type Maker = 'owner' | 'kage'
// granted: when the owner approved its db_read on Kage's card (runtime/kagelets.ts). standing: by a standing approval.
export type Kagelet = { name: string; key: string; link: string; cron: string; tools: string[]; job: string; paused: boolean; by: Maker; why: string; resumed?: number; granted?: number; standing?: true }

// Flat front matter (key: value lines between --- lines), then the job.
export function parseKagelet(name: string, text: string): Kagelet | { error: string } {
  if (!NAME.test(name)) return { error: `the file name "${name}" must be a short lowercase name: letters, digits, dashes` }
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text.replace(/\r\n/g, '\n'))
  if (!m) return { error: 'it needs front matter between --- lines: thread, schedule, tools' }
  const head = new Map(m[1]!.split('\n').map(l => /^(\w+):\s*(.*)$/.exec(l.trim())).filter(x => !!x).map(x => [x[1]!, x[2]!.trim()]))
  const link = head.get('thread') ?? ''
  const thread = slackLinkKey(link)
  if (!thread) return { error: 'thread must be a Slack message link ("Copy link" in Slack)' }
  const cron = head.get('schedule') ?? ''
  try { parseCron(cron) } catch { return { error: `schedule must be a cron line like "0 9 * * 1-5", not "${cron}"` } }
  const job = m[2]!.trim()
  if (!job) return { error: 'the job, below the front matter, is empty' }
  const tools = (head.get('tools') ?? '').split(',').map(t => t.trim()).filter(Boolean)
  const grant = GRANTED.exec(head.get('granted') ?? '')
  const granted = Date.parse(grant?.[2] ?? '')
  // Checked on every read, so a file that says by: kage cannot hold it even when written by hand.
  if (head.get('by') === 'kage' && tools.includes(DB_READ) && !(granted >= 0)) return { error: `a kagelet Kage made cannot hold ${DB_READ} without the owner's approval on Kage's card` }
  return { name, key: `${thread}#side-kagelet-${name}`, link, cron, tools, job, paused: isPaused(head.get('paused')),
    by: head.get('by') === 'kage' ? 'kage' : 'owner', why: head.get('why') ?? '',
    ...(Date.parse(head.get('resumed') ?? '') >= 0 && { resumed: Date.parse(head.get('resumed')!) }), ...(granted >= 0 && { granted }), ...(granted >= 0 && grant![1] === 'standing approval' && { standing: true as const }) }
}

// Fails closed: any value but none, no or false pauses it, so a typo never starts a kagelet.
const isPaused = (v = '') => !['', 'no', 'false'].includes(v.toLowerCase())

// Pause or resume by the paused line in the front matter, so the file stays the one place a kagelet is set.
// now: a resume also stamps its time, so the daily cost cap counts only what it spends after it.
export function setPaused(text: string, paused: boolean, now?: number) {
  const m = /^(---\r?\n)([\s\S]*?\r?\n)(---)/.exec(text)
  if (!m) return text
  if (!paused && !/^\s*paused:/m.test(m[2]!)) return text
  let head = m[2]!.replace(/^\s*paused:.*\r?\n/gm, '')
  if (!paused && now !== undefined) head = `${head.replace(/^\s*resumed:.*\r?\n/gm, '')}resumed: ${new Date(now).toISOString()}\n`
  return `${m[1]}${head}${paused ? 'paused: yes\n' : ''}${text.slice(m[1]!.length + m[2]!.length)}`
}

// What kage add kagelet writes: paused, with a thread line that does not parse, so nothing runs until it is filled in.
export const starterFile = () => `---
thread: paste the Slack link of the thread it posts in ("Copy link" on a message there)
schedule: 0 9 * * 1-5
tools: WebSearch, WebFetch
paused: yes
---
Say what to check, where, and what to post in the thread. For example: every weekday at 9, read https://status.example.com and post a three-line summary.
`

// The grant name for the database tool (runtime/kage-tools.ts). Only the owner grants it: by hand in the file,
// or by a yes on Kage's card, which the file records as its granted line.
export const DB_READ = 'db_read'
const GRANTED = new RegExp(`^${DB_READ} by (the owner|standing approval), (\\S+)$`)

// What a kagelet made on its own may be granted: the v1 web tools, never an MCP tool. Only the owner widens it.
export const DEFAULT_GRANT = ['WebSearch', 'WebFetch']

// The file the manager's tool writes. Refused with the reason when it would not run, would be granted a tool v1
// cannot grant, Kage made it and asks for more than DEFAULT_GRANT, or it holds db_read with no owner's yes.
// granted: when the owner said yes to its db_read. standing: that yes was a standing approval, not a card.
export function kageletFile(f: { thread: string; schedule: string; tools: string[]; job: string; by: Maker; why: string; paused?: boolean; granted?: number; standing?: boolean }): string | { error: string } {
  // One line each, so no value can add a front matter line of its own (a second tools or paused line).
  for (const [k, v] of Object.entries({ thread: f.thread, schedule: f.schedule, why: f.why, tool: f.tools.join(',') })) if (/[\r\n]/.test(v)) return { error: `the ${k} must be one line` }
  const bad = f.tools.find(t => !grantable(t))
  if (bad) return { error: `a kagelet can be granted only web tools, MCP tools and ${DB_READ}, not ${bad}. A wider grant is the owner's call.` }
  const db = f.tools.includes(DB_READ)
  if (db && f.granted === undefined) return { error: `${DB_READ} needs the owner's yes on Kage's card` }
  const wide = f.by === 'kage' && f.tools.find(t => !DEFAULT_GRANT.includes(t) && t !== DB_READ)
  if (wide) return { error: `a kagelet Kage makes on its own gets only ${DEFAULT_GRANT.join(' and ')}, not ${wide}. Ask the owner to grant it.` }
  const text = `---\nthread: ${f.thread}\nschedule: ${f.schedule}\ntools: ${f.tools.join(', ')}\nby: ${f.by}\nwhy: ${f.why}\n${db ? `granted: ${DB_READ} by ${f.standing ? 'standing approval' : 'the owner'}, ${new Date(f.granted!).toISOString()}\n` : ''}${f.paused ? 'paused: yes\n' : ''}---\n${f.job.trim()}\n`
  const sp = parseKagelet('check', text)
  return 'error' in sp ? sp : text
}

export type Report = { at: number; summary: string; needs?: string }
// costToday: since midnight, or since its last resume today. avg7: its daily average over the 7 days before today.
export type KageletRow = { name: string; state: 'runs' | 'paused' | 'broken'; error?: string; key?: string; link?: string; cron?: string; tools: string[]; lastRun?: number; next?: number; costToday: number; avg7: number; result?: Report; by?: Maker; why?: string; standing?: true }
// One row per file for kage list, kage top and the manager. runs, costs and reports are the ledgers (core/ledgers.ts).
export function kageletRows(files: { name: string; text: string }[], o: { runs: string; costs: string; reports?: string; now: number }): KageletRow[] {
  const results = new Map<string, Report>()
  for (const l of (o.reports ?? '').split('\n')) {
    const [when = '', name = '', summary = '', needs = ''] = l.split('\t')
    if (name) results.set(name, { at: Date.parse(when), summary, ...(needs && { needs }) })
  }
  const midnight = new Date(o.now).setHours(0, 0, 0, 0)
  // The 7 days before today, by the calendar, so a daylight-saving day still counts as one.
  const today = spendSince(o.costs, midnight), week = spendSince(o.costs, new Date(midnight).setDate(new Date(midnight).getDate() - 7))
  const last = new Map<string, number>()
  for (const l of o.runs.split('\n')) {
    const [when = '', id = ''] = l.split('\t')
    // spec- is the id from before the rename (#77): its old runs still count.
    const name = id.startsWith('kagelet-') ? id.slice(8) : id.startsWith('spec-') ? id.slice(5) : ''
    if (name) last.set(name, Date.parse(when))
  }
  return [...files].sort((a, b) => a.name.localeCompare(b.name)).map((f): KageletRow => {
    const sp = parseKagelet(f.name, f.text)
    if ('error' in sp) return { name: f.name, state: 'broken', error: sp.error, tools: [], costToday: 0, avg7: 0 }
    const next = sp.paused ? undefined : nextRun(sp.cron, new Date(o.now), 366 * 24 * 3600_000)?.getTime()
    return {
      name: sp.name, state: sp.paused ? 'paused' : 'runs', key: sp.key, link: sp.link, cron: sp.cron, tools: sp.tools,
      ...(last.has(sp.name) && { lastRun: last.get(sp.name) }), ...(next !== undefined && { next }), costToday: spendSince(o.costs, Math.max(midnight, sp.resumed ?? 0)).find(s => s.key === sp.key)?.usd ?? 0,
      avg7: Math.round(((week.find(s => s.key === sp.key)?.usd ?? 0) - (today.find(s => s.key === sp.key)?.usd ?? 0)) / 7 * 1e6) / 1e6,
      ...(results.has(sp.name) && { result: results.get(sp.name) }), by: sp.by, why: sp.why, ...(sp.standing && { standing: true as const }),
    }
  })
}

export function rowLine(r: KageletRow, now: number) {
  if (r.state === 'broken') return `${r.name.padEnd(16)} does not run: ${r.error}`
  return [r.name.padEnd(16), r.state.padEnd(6), r.cron!.padEnd(15), `last ${r.lastRun ? clockTime(r.lastRun, now) : 'never'}`.padEnd(14),
    `next ${whenLabel(r.next, now)}`.padEnd(14), `$${r.costToday.toFixed(2)} today, avg $${r.avg7.toFixed(2)}`].join(' ')
}

export const resultLine = (r: KageletRow, now: number) => !r.result ? 'no report yet'
  : `${clockTime(r.result.at, now)} ${r.result.needs ? `needs: ${r.result.needs} (${r.result.summary})` : r.result.summary}`

// Of Kage's own tools, a kagelet has only those for its thread, whatever its grant says: the rest act as the
// owner (message_people, away), outlive the run (schedule) or need the owner (log_prod_write).
const THREAD_TOOLS = ['reply', 'edit_message', 'delete_message', 'report'].map(t => `mcp__kage__${t}`)
// What a grant may name: web tools and outside MCP tools, an allowlist so a new built-in tool stays out. No file,
// shell or agent tool, granted or not: one could rewrite the kagelet's own grant or read the env file with the
// tokens. ponytail: a file grant needs a sandboxed work folder first.
const grantable = (t: string) => t === DB_READ || t === 'WebFetch' || t === 'WebSearch' || (t.startsWith('mcp__') && !t.startsWith('mcp__kage__') && !t.startsWith('mcp__plugin_kage_'))

// The grant only shrinks: a tool outside it is denied.
export function grantRefusal(tool: string, grant: string[], input: Record<string, unknown> = {}) {
  if (THREAD_TOOLS.includes(tool)) return undefined
  if (tool === `mcp__kage__${DB_READ}`) return grant.includes(DB_READ) ? undefined : `${DB_READ} is outside this kagelet's grant. Only the owner grants it.`
  if (!grantable(tool)) return `A kagelet can be granted only web and MCP tools, not ${tool}. Say in the thread what you needed: your manager decides.`
  if (tool === 'WebFetch' && !/^https?:\/\//i.test(String(input.url ?? ''))) return 'A kagelet fetches only http and https addresses.'
  return grant.includes(tool) ? undefined
    : `${tool} is outside this kagelet's grant (${grant.join(', ') || 'no tools'}). Say in the thread what you needed: your manager decides.`
}

// A standing approval (#96): the owner's yes on a db_read card, kept in kage.db as the tool and a hash of the read
// command (never the command: it may hold a host or a password). One per tool: a later yes replaces it.
export type Standing = { tool: string; command: string; at: number }
// It covers a later db_read grant through the same command, asked in the owner's own session (one that could show
// the card). Never another tool, another command or a teammate's session, so never a write, a send or a cap raise.
export const standingApplies = (a: Standing | undefined, r: { tool: string; command: string; owner: boolean }) =>
  !!a && r.owner && a.tool === DB_READ && r.tool === a.tool && r.command === a.command

// Revoking a standing approval: every file that holds db_read by it, rewritten without db_read and its granted line.
// A grant the owner gave on its own card stays: that yes was for that kagelet.
export function revokeStanding(files: { name: string; text: string }[]): { name: string; text: string }[] {
  return files.flatMap(f => {
    const k = parseKagelet(f.name, f.text)
    if ('error' in k || !k.standing) return []
    const text = f.text.replace(/^[ \t]*granted:.*\r?\n/m, '').replace(/^[ \t]*tools:.*$/m, `tools: ${k.tools.filter(t => t !== DB_READ).join(', ')}`)
    return [{ name: f.name, text }]
  })
}

// The cost caps (#96), checked on the hub's job loop. A row's costToday counts since midnight or its resume.
// each: KAGE_KAGELET_DAILY_USD, one kagelet. total: KAGE_KAGELET_TOTAL_DAILY_USD, all of them together. Both are
// off unless set: Kage may run on a flat subscription, where spend is watched (costFlags), not capped.
export type Caps = { each?: number; total?: number }
const usd = (n: number) => `$${n.toFixed(2)}`
const spentToday = (rows: KageletRow[]) => Math.round(rows.reduce((s, r) => s + r.costToday, 0) * 1e6) / 1e6

// pause: the running kagelets to pause, and why. tell: the owner's DMs. A tell with an id goes once a day (sent: the
// ids already sent today). A pause at a kagelet's own cap has none: each one waits on a resume.
export function capCheck(rows: KageletRow[], caps: Caps, sent: string[], title: string) {
  const runs = rows.filter(r => r.state === 'runs')
  const total = spentToday(rows)
  const allOver = runs.length > 0 && caps.total !== undefined && total >= caps.total
  const pause: { name: string; why: string }[] = []
  const tell: { id?: string; text: string }[] = []
  for (const r of runs) {
    if (caps.each !== undefined && r.costToday >= caps.each) {
      const why = `${CAP_PAUSE} ${usd(r.costToday)} today, at or over its daily cap of ${usd(caps.each)} (KAGE_KAGELET_DAILY_USD)`
      pause.push({ name: r.name, why })
      tell.push({ text: `Kagelet *${r.name}* is ${why}. Resume it with kage top or by asking ${title}.` })
    } else if (allOver) pause.push({ name: r.name, why: `${CAP_PAUSE} ${usd(r.costToday)} today, and all kagelets together spent ${usd(total)}, at or over the total daily cap of ${usd(caps.total!)} (KAGE_KAGELET_TOTAL_DAILY_USD)` })
    else if (caps.each !== undefined && r.costToday >= 0.8 * caps.each) tell.push({ id: r.name, text: `Kagelet *${r.name}* spent ${usd(r.costToday)} today, 80% of its daily cap of ${usd(caps.each)}. At the cap it pauses.` })
  }
  if (allOver) tell.push({ id: 'total', text: `Every kagelet is paused: together they spent ${usd(total)} today, at or over the total daily cap of ${usd(caps.total!)} (KAGE_KAGELET_TOTAL_DAILY_USD). A cap raise is yours, in the settings file.` })
  else if (runs.length && caps.total !== undefined && total >= 0.8 * caps.total) tell.push({ id: 'total-80', text: `Kagelets together spent ${usd(total)} today, 80% of the total daily cap of ${usd(caps.total)}. At the cap every kagelet pauses.` })
  return { pause, tell: tell.filter(t => !t.id || !sent.includes(t.id)) }
}

// What a kagelet's session may spend before a cap: the Agent SDK's maxBudgetUsd, which ends a long run at the cap
// mid-turn, not at its next result. At least a cent, so a set cap always sets a budget. No cap set: none.
export function budgetLeft(rows: KageletRow[], key: string, caps: Caps): number | undefined {
  const left = [caps.each === undefined ? Infinity : caps.each - (rows.find(r => r.key === key)?.costToday ?? 0), caps.total === undefined ? Infinity : caps.total - spentToday(rows)]
  return caps.each === undefined && caps.total === undefined ? undefined : Math.max(0.01, Math.round(Math.min(...left) * 100) / 100)
}

// Cost monitoring (#96): flags, never stops. A kagelet that spent today over 3x its 7-day daily average and over
// SPIKE_FLOOR, or a finished run of today (a later run started, or an hour passed) with no costs row in it.
// At most one line per kagelet a day: the hub files it in the reports ledger under cost:<name>, which no kagelet
// name can be, and a row there today means it was said.
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
