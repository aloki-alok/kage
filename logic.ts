// Pure rules: who may drive the agent, and how replies fit Slack.

// owner: the person whose user token hears messages. bot: the app's bot user.
// botDm: the owner's DM with the bot. name: the word typed after "@" (e.g. kage).
// teammates: Slack ids the owner lets start tasks by tagging, only where the owner is too.
export type Ids = { owner: string; bot: string; botDm: string; name: string; teammates: string[] }

// The name goes into a regex and a Slack mention, so it stays a short plain word.
export const validName = (name: string) => /^[a-z][a-z0-9-]{1,20}$/.test(name)

export type SlackMessage = {
  channel: string
  ts: string
  user?: string
  bot_id?: string
  app_id?: string
  client_msg_id?: string
  subtype?: string
  text?: string
  thread_ts?: string
}

export type Trigger =
  | { kind: 'task'; text: string }
  | { kind: 'verdict'; request_id: string; behavior: 'allow' | 'deny' }
  | null

// Claude Code's request ids: five lowercase letters without "l".
const VERDICT_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i
// Plain messages, threaded broadcasts and uploads. Edits, joins and deletes never trigger.
const TASK_SUBTYPES = new Set([undefined, 'thread_broadcast', 'file_share'])

export function classify(m: SlackMessage, ids: Ids): Trigger {
  // The gate: a message the owner typed in a Slack client. An app posting with the
  // owner's user token (the reply fallback, a connector) has user=owner but no
  // client_msg_id, and usually an app_id.
  const isOwner = m.user === ids.owner
  if (!isOwner && !ids.teammates.includes(m.user ?? '')) return null
  if (m.bot_id || m.app_id || !m.client_msg_id) return null
  if (!TASK_SUBTYPES.has(m.subtype)) return null
  // A Slack mention token, or "@name" typed as plain text (works whatever the bot's display name is).
  const tag = new RegExp(`(?:<@${ids.bot}>|(?<![\\w@.])@${ids.name}(?![\\w.-]))[ \\t]?`, 'gi')
  const raw = m.text ?? ''
  const tagged = tag.test(raw)
  const text = raw.replace(tag, '').trim()
  // Only the owner reaches the DM, so only the owner can approve a prompt.
  const inDm = isOwner && m.channel === ids.botDm
  if (inDm) {
    // Approvals count only in the private DM, where the prompts are sent.
    const v = VERDICT_RE.exec(text)
    if (v) {
      return {
        kind: 'verdict',
        request_id: v[2]!.toLowerCase(),
        behavior: v[1]!.toLowerCase().startsWith('y') ? 'allow' : 'deny',
      }
    }
    return { kind: 'task', text }
  }
  if (!tagged) return null
  return { kind: 'task', text }
}

// Replies never ping a crowd or a person, whatever the model writes.
export function safeReply(text: string): string {
  return text.replace(/<!(channel|here|everyone)[^>]*>/g, '$1').replace(/<@([A-Z0-9]+)>/g, '@$1')
}

// Text rules alone did not stop a password reaching a thread (2026-11-01), so the reply tool
// checks. A hit sends the reply back with a hint to use private=true; a false alarm costs one retry.
const SECRET_SHAPES: [string, RegExp][] = [
  ['AWS access key', /\b(AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['Slack token', /\bxox[abprs]-[0-9A-Za-z-]{10,}/],
  ['GitHub token', /\b(gh[pousr]_[0-9A-Za-z]{30,}|github_pat_\w{20,})/],
  ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['API key', /\bsk-(proj-|ant-)?[\w-]{20,}/],
  ['secret assignment', /\b\w*(secret|token|password|passwd|api_?key)\w*\s*[=:]\s*['"]?[^\s'"`]{12,}/i],
]

export function findSecret(text: string): string | undefined {
  for (const [name, shape] of SECRET_SHAPES) if (shape.test(text)) return name
  // A strong-password-shaped code span (upper, lower and digit) near the word password or secret.
  let prev = ''
  for (const line of text.split('\n')) {
    const near = `${prev} ${line}`
    prev = line
    if (!/pass(word|wd)|secret|credential/i.test(near)) continue
    for (const [, span = ''] of line.matchAll(/`([^`\s]{10,})`/g))
      if (/[A-Z]/.test(span) && /[a-z]/.test(span) && /\d/.test(span)) return 'password'
  }
}

// Whether a reply may go out as written. The owner may let a secret into a thread by asking;
// a teammate's task never can, whatever the reply claims.
export function secretRefusal(
  text: string, o: { private?: boolean; ownerAsked?: boolean; fromOwner: boolean },
): string | undefined {
  if (o.private) return
  const secret = findSecret(text)
  if (!secret || (o.ownerAsked && o.fromOwner)) return
  return o.fromOwner
    ? `refused: this looks like a ${secret}, and threads are seen by others. Send it with private=true, or set owner_asked=true only if the owner's own task line asks for it in the thread.`
    : `refused: this looks like a ${secret}, and this task is from a teammate. Send the secret to the owner with private=true.`
}

// Other people's words go to Claude quoted and labelled by Slack id (names can be
// set to anything), and can't close the <channel> tag they arrive in.
export function quoteMessage(
  x: { user?: string; ts?: string; text?: string; client_msg_id?: string }, owner: string,
): string {
  // The owner's id without client_msg_id is an app posting with their token, not them.
  const who = x.user !== owner ? `other:${x.user ?? 'bot'}` : x.client_msg_id ? 'owner' : 'app-as-owner'
  const body = (x.text ?? '').replace(/<\/channel/gi, '<\\/channel')
  return body.split('\n').map((l, i) => `> ${i === 0 ? `[${who} ${x.ts}] ` : ''}${l}`).join('\n')
}

// The instruction line of a task. A teammate's text is less trusted than the owner's: it can't
// close the <channel> tag, and it stays on one line so it can't forge a "Task from <owner>:" line.
export function taskLine(text: string, from: { name: string; teammate?: string }): string {
  let t = text.replace(/<\/?channel/gi, m => m.replace('<', '&lt;'))
  if (from.teammate) t = t.replace(/\s+/g, ' ').trim()
  t ||= '(empty: they only tagged you)'
  return from.teammate ? `Teammate task (${from.teammate}, ${from.name}, not the owner): ${t}` : `Task from ${from.name}: ${t}`
}

// Display names are set by their owners: one line, no angle brackets, before they reach Claude.
export const plainName = (name: string) => name.replace(/[<>]/g, '').replace(/\s+/g, ' ').trim()

// Slack caps a message near 40k chars but long blocks render badly; split on lines.
export function splitForSlack(text: string, max = 3500): string[] {
  const parts: string[] = []
  let cur = ''
  for (const line of text.split('\n')) {
    const next = cur ? `${cur}\n${line}` : line
    if (next.length <= max) {
      cur = next
      continue
    }
    if (cur) parts.push(cur)
    let rest = line
    while (rest.length > max) {
      parts.push(rest.slice(0, max))
      rest = rest.slice(max)
    }
    cur = rest
  }
  parts.push(cur)
  return parts
}

// One Claude session per conversation: a thread, or the top-level DM with the bot.
export const threadKey = (m: { channel: string; ts: string; thread_ts?: string }, botDm: string) =>
  m.channel === botDm && !m.thread_ts ? 'dm' : `${m.channel}:${m.thread_ts ?? m.ts}`

// start/stop run a session's window (start throws if it can't). lastActivity: when it last wrote
// its transcript (ms). busy: Claude is mid-turn, which a long tool call can be with no writes.
export type Windows = { start(key: string, id: string): void; stop(key: string): void; lastActivity(key: string): number; busy(key: string): boolean }

// Routes tasks to one session per thread. Each thread keeps its session id for good, so a
// window that closed or restarted resumes the same conversation. At most `max` windows run.
export class Dispatcher<M> {
  #w: Windows
  #o: { max: number; idleMs: number; connectMs: number; newId: () => string }
  #ids: Map<string, string>
  #live = new Set<string>()
  #conns = new Map<string, (m: M) => void>()
  #pending = new Map<string, M[]>()
  #touched = new Map<string, number>()
  #waiting: string[] = []
  #perms = new Map<string, string>()
  #startedAt = new Map<string, number>()

  constructor(w: Windows, o: { max: number; idleMs: number; connectMs: number; newId: () => string; saved?: Record<string, string> }) {
    this.#w = w
    this.#o = o
    this.#ids = new Map(Object.entries(o.saved ?? {}))
  }

  saved = () => Object.fromEntries(this.#ids)
  connection = (key: string) => this.#conns.get(key)

  // Windows already running when the router starts (it restarted, they did not).
  adopt(keys: string[], now: number) {
    for (const k of keys) if (this.#ids.has(k)) { this.#live.add(k); this.#startedAt.set(k, now) }
  }

  // 'failed': the window could not open; the task was not kept.
  task(key: string, msg: M, now: number): 'sent' | 'starting' | 'queued' | 'failed' {
    this.#touched.set(key, now)
    const send = this.#conns.get(key)
    if (send) { send(msg); return 'sent' }
    // The connect clock runs from the first task left waiting, so a window that is only
    // restarting gets the full connectMs again.
    if (!this.#pending.has(key)) this.#startedAt.set(key, now)
    this.#pending.set(key, [...(this.#pending.get(key) ?? []), msg])
    if (this.#live.has(key)) return 'starting'
    if (this.#live.size < this.#o.max) {
      if (this.#start(key, now)) return 'starting'
      this.#pending.delete(key)
      return 'failed'
    }
    if (!this.#waiting.includes(key)) this.#waiting.push(key)
    return 'queued'
  }

  connect(key: string, send: (m: M) => void): boolean {
    if (!this.#live.has(key)) return false
    this.#conns.set(key, send)
    for (const m of this.#pending.get(key) ?? []) send(m)
    this.#pending.delete(key)
    return true
  }

  // Only the current connection's close counts; a stale one closing late changes nothing.
  // Its open approvals go with it: the Claude Code process that asked is gone.
  disconnect(key: string, send: (m: M) => void) {
    if (this.#conns.get(key) !== send) return
    this.#conns.delete(key)
    for (const [id, k] of this.#perms) if (k === key) this.#perms.delete(id)
  }

  permission(key: string, requestId: string) { this.#perms.set(requestId, key) }

  verdict(requestId: string, msg: M): boolean {
    const send = this.#conns.get(this.#perms.get(requestId) ?? '')
    if (!send) return false
    this.#perms.delete(requestId)
    send(msg)
    return true
  }

  // Closes windows idle for idleMs and windows that never connected within connectMs, then starts
  // waiting threads. Returns the tasks it could not deliver, so the router can say so in Slack.
  sweep(now: number): M[] {
    const dropped: M[] = []
    const asking = new Set(this.#perms.values())
    for (const k of this.#live) {
      const pending = this.#pending.get(k)
      if (pending && !this.#conns.has(k)) {
        if (now - (this.#startedAt.get(k) ?? now) < this.#o.connectMs) continue
        dropped.push(...pending)
        this.#pending.delete(k)
      } else {
        const last = Math.max(this.#touched.get(k) ?? 0, this.#w.lastActivity(k))
        if (pending || now - last < this.#o.idleMs || asking.has(k) || this.#w.busy(k)) continue
      }
      this.#w.stop(k)
      this.#live.delete(k)
      this.#conns.delete(k)
      for (const [id, key] of this.#perms) if (key === k) this.#perms.delete(id)
    }
    while (this.#waiting.length && this.#live.size < this.#o.max) {
      const k = this.#waiting.shift()!
      if (!this.#start(k, now)) {
        dropped.push(...this.#pending.get(k) ?? [])
        this.#pending.delete(k)
      }
    }
    return dropped
  }

  #start(key: string, now: number): boolean {
    if (!this.#ids.has(key)) this.#ids.set(key, this.#o.newId())
    try {
      this.#w.start(key, this.#ids.get(key)!)
    } catch {
      return false
    }
    this.#live.add(key)
    this.#startedAt.set(key, now)
    return true
  }
}

// Who "add <query>" means: a Slack id or pasted mention as is, otherwise active people whose
// handle, display name or full name equals the query. Two matches go back to the caller to pick.
export type Person = { id: string; name?: string; real_name?: string; deleted?: boolean; is_bot?: boolean; profile?: { display_name?: string } }
export function findPeople(people: Person[], query: string): { id: string; name: string }[] {
  const id = /^<?@?([UW][A-Z0-9]{2,})>?$/.exec(query.trim())?.[1]
  if (id) return [{ id, name: id }]
  const q = query.trim().replace(/^@/, '').toLowerCase()
  const first = (s?: string) => (s ?? '').toLowerCase().split(/\s+/)[0]
  return people
    .filter(p => !p.deleted && !p.is_bot && p.id !== 'USLACKBOT')
    .filter(p => [p.name, p.profile?.display_name, p.real_name].some(s => s && s.toLowerCase() === q)
      || (!q.includes(' ') && first(p.real_name) === q))
    .map(p => ({ id: p.id, name: p.real_name || p.name || p.id }))
}

// Read the way config.ts reads the env file: optional indent, spaces and quotes.
const TEAMMATES_LINE = /^\s*KAGE_TEAMMATES\s*=\s*["']?(.*?)["']?\s*$/
export const teammatesIn = (env: string) =>
  (env.split('\n').map(l => TEAMMATES_LINE.exec(l)?.[1]).findLast(v => v !== undefined) ?? '')
    .split(',').map(s => s.trim()).filter(Boolean)

// The env file with its KAGE_TEAMMATES line set to these ids; every other line stays as it was.
export function withTeammates(env: string, ids: string[]): string {
  const rest = env.replace(/\n+$/, '').split('\n').filter(l => !TEAMMATES_LINE.test(l))
  const unique = [...new Set(ids)]
  return [...rest, ...(unique.length ? [`KAGE_TEAMMATES=${unique.join(',')}`] : [])].join('\n') + '\n'
}

// Repeating checks a session made with CronCreate live only in its Claude Code process, so
// closing the pane ends them. These are the jobs still alive: made since `since` (when the
// running process started), not cancelled, and not expired (recurring after 7 days, as Claude
// Code does; ponytail: a one-shot after a day, since its fire time isn't parsed).
export function liveCronJobs(results: { timestamp: string; text: string }[], since: number, now: number): string[] {
  const jobs = new Map<string, number>()
  for (const r of results) {
    const t = Date.parse(r.timestamp)
    const made = /Scheduled (\S+) job ([0-9a-f]+)/.exec(r.text)
    if (made && t >= since) jobs.set(made[2]!, t + (made[1] === 'recurring' ? 7 : 1) * 24 * 3600_000)
    const gone = /Cancelled job ([0-9a-f]+)/.exec(r.text)
    if (gone) jobs.delete(gone[1]!)
  }
  return [...jobs].filter(([, until]) => now < until).map(([id]) => id)
}

// One ledger row. Cells never hold a tab or newline, so a row is always one line.
export const tsvRow = (cells: (string | undefined)[]) => cells.map(c => (c ?? '').replace(/[\t\r\n]+/g, ' ')).join('\t') + '\n'

// waiting.tsv is append-only (every thread's pane writes it): when, open|answered, thread, link, what.
// An offer stays open until its thread gets a new task.
// ponytail: any new task closes it, even from someone else in the thread; match the asker if that bites.
export function openWaiting(tsv: string): { when: string; link: string; what: string }[] {
  const open = new Map<string, { when: string; link: string; what: string }[]>()
  for (const line of tsv.split('\n')) {
    const [when = '', status, thread = '', link = '', what = ''] = line.split('\t')
    if (status === 'answered') open.delete(thread)
    else if (status === 'open') open.set(thread, [...(open.get(thread) ?? []), { when, link, what }])
  }
  return [...open.values()].flat()
}
