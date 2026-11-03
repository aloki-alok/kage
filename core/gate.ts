// Who may drive Kage and what Claude reads: the sender gate, the task line, quoting, teammates.

// owner: the person whose user token hears messages. bot: the app's bot user.
// botDm: the owner's DM with the bot. name: the word typed after "@" (e.g. kage).
// teammates: Slack ids the owner lets start tasks by tagging, only where the owner is too.
export type Ids = { owner: string; bot: string; botDm: string; name: string; teammates: string[]; team?: string }

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
  channel_type?: string
}

// side: run it in its own session, beside the thread's (which may be busy with something else).
// status: the owner asks the hub what is running; no session reads it.
export type Trigger =
  | { kind: 'task'; text: string; side?: true }
  | { kind: 'status' }
  | { kind: 'verdict'; request_id: string; behavior: 'allow' | 'deny' }
  | null

// Only the exact "side:" counts, so "side effects of ..." stays a normal task. Owner only, so a
// teammate can't open extra sessions and push the owner's out.
const SIDE_RE = /^side:\s*/i
const task = (text: string, isOwner: boolean): Trigger => {
  if (isOwner && /^status$/i.test(text)) return { kind: 'status' }
  const side = isOwner ? SIDE_RE.exec(text) : null
  return side ? { kind: 'task', text: text.slice(side[0].length), side: true } : { kind: 'task', text }
}

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
    return task(text, true)
  }
  if (!tagged) return null
  return task(text, isOwner)
}

// Other people's words go to Claude quoted and labelled by Slack id (names can be
// set to anything), and can't close the <channel> tag they arrive in.
export function quoteMessage(
  x: { user?: string; ts?: string; text?: string; client_msg_id?: string }, owner: string,
  self?: { bot: string; title: string },
): string {
  // The owner's id without client_msg_id is an app posting with their token, not them. Kage's own
  // fallback posts are those, marked "*Kage:*" (server.ts post).
  const mine = self && (x.user === self.bot || (x.user === owner && !x.client_msg_id && (x.text ?? '').startsWith(`*${self.title}:*`)))
  const who = mine ? `you (${self.title})`
    : x.user !== owner ? `other:${x.user ?? 'bot'}` : x.client_msg_id ? 'owner' : 'app-as-owner'
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
