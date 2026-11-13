// Who may drive Kage and what Claude reads: the sender gate, the task line, quoting, teammates.
import { agentTag, filesTag, postedByTrustedApp, typedByPerson, type SlackMessage } from './slack-message.ts'

// owner: the person whose user token hears messages. bot: the app's bot user.
// botDm: the owner's DM with the bot. name: the word typed after "@" (e.g. kage).
// teammates: Slack ids the owner lets start tasks by tagging, only where the owner is too.
// apps: Slack app ids of teammates' own agents; their posts count as that teammate's, never the owner's.
export type Ids = { owner: string; bot: string; botDm: string; name: string; teammates: string[]; apps?: string[]; team?: string }

// The name goes into a regex and a Slack mention, so it stays a short plain word.
export const validName = (name: string) => /^[a-z][a-z0-9-]{1,20}$/.test(name)

// side: run it in its own session, beside the thread's (which may be busy with something else).
// status: the owner asks the hub what is running; no session reads it.
export type Trigger =
  | { kind: 'task'; text: string; side?: true }
  | { kind: 'status' }
  // card: the owner wrote something other than yes or no in an approval card's thread.
  | { kind: 'card'; request_id: string }
  | { kind: 'verdict'; request_id: string; behavior: 'allow' | 'deny' }
  | null

// Only the exact "side:" counts, so "side effects of ..." stays a normal task. Owner only, so a
// teammate can't open extra sessions and push the owner's out.
const SIDE_RE = /^side:\s*/i
const task = (text: string, isOwner: boolean, files: string): Trigger => {
  if (isOwner && /^status$/i.test(text)) return { kind: 'status' }
  const side = isOwner ? SIDE_RE.exec(text) : null
  return side ? { kind: 'task', text: text.slice(side[0].length) + files, side: true } : { kind: 'task', text: text + files }
}

// Claude Code's request ids: five lowercase letters without "l".
const VERDICT_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i
// Inside a card's thread the card names the request, so the first word alone decides.
const CARD_YES = /^(y|yes|ok|okay|sure|approve|approved|go)\b/i
const CARD_NO = /^(n|no|deny|stop|cancel)\b/i
// card: the request id of the approval card this message replies under, if it does.
export function classify(m: SlackMessage, ids: Ids, card?: string): Trigger {
  // The gate: a message the owner (or a listed teammate) typed in a Slack client.
  const isOwner = m.user === ids.owner
  if (!isOwner && !ids.teammates.includes(m.user ?? '')) return null
  if (!typedByPerson(m) && (isOwner || !postedByTrustedApp(m, ids.apps ?? []))) return null
  const tag = agentTag(ids.bot, ids.name)
  const raw = m.text ?? ''
  const tagged = tag.test(raw)
  const text = raw.replace(tag, '').trim()
  // Only the owner reaches the DM, so only the owner can approve a prompt.
  const inDm = isOwner && m.channel === ids.botDm
  if (inDm) {
    // Approvals count only in the private DM, where the prompts are sent. Slack keeps the
    // backticks when the owner pastes the card's `yes abcde`.
    const plain = text.replaceAll('`', '').trim()
    if (card) {
      // Never a task: a new session for this thread would ask for the same tool call again.
      const behavior = CARD_YES.test(plain) ? 'allow' : CARD_NO.test(plain) ? 'deny' : null
      return behavior ? { kind: 'verdict', request_id: card, behavior } : { kind: 'card', request_id: card }
    }
    const v = VERDICT_RE.exec(plain)
    if (v) {
      return {
        kind: 'verdict',
        request_id: v[2]!.toLowerCase(),
        behavior: v[1]!.toLowerCase().startsWith('y') ? 'allow' : 'deny',
      }
    }
    return task(text, true, filesTag(m))
  }
  if (!tagged) return null
  return task(text, isOwner, filesTag(m))
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
  const body = noChannelTag(x.text ?? '')
  return body.split('\n').map((l, i) => `> ${i === 0 ? `[${who} ${x.ts}] ` : ''}${l}`).join('\n')
}

// Text from outside can neither open nor close the <channel> tag Claude reads tasks in.
export const noChannelTag = (s: string) => s.replace(/<(\/?channel)/gi, '&lt;$1')

// The instruction line of a task. A teammate's text is less trusted than the owner's: it can't
// close the <channel> tag, and it stays on one line so it can't forge a "Task from <owner>:" line.
export function taskLine(text: string, from: { name: string; teammate?: string }): string {
  let t = noChannelTag(text)
  if (from.teammate) t = t.replace(/\s+/g, ' ').trim()
  t ||= '(empty: they only tagged you)'
  return from.teammate ? `Teammate task (${from.teammate}, ${from.name}, not the owner): ${t}` : `Task from ${from.name}: ${t}`
}

// The teammate behind a task, read back from the first line taskLine wrote; none on the owner's task.
export function teammateOf(content: string): { id: string; name: string } | undefined {
  const m = /^Teammate task \(([UW][A-Z0-9]+), (.*?), not the owner\): /.exec(content)
  return m ? { id: m[1]!, name: m[2]! } : undefined
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

// A comma separated id list in the env file (KAGE_TEAMMATES, KAGE_TRUSTED_APPS). Read the way
// config.ts reads the file: optional indent, spaces and quotes.
const listLine = (name: string) => new RegExp(`^\\s*${name}\\s*=\\s*["']?(.*?)["']?\\s*$`)
export const listIn = (env: string, name: string) =>
  (env.split('\n').map(l => listLine(name).exec(l)?.[1]).findLast(v => v !== undefined) ?? '')
    .split(',').map(s => s.trim()).filter(Boolean)

// The env file with that list set to these ids; every other line stays as it was.
export function withList(env: string, name: string, ids: string[]): string {
  const rest = env.replace(/\n+$/, '').split('\n').filter(l => !listLine(name).test(l))
  const unique = [...new Set(ids)]
  return [...rest, ...(unique.length ? [`${name}=${unique.join(',')}`] : [])].join('\n') + '\n'
}

// A Slack app id, as config.ts accepts it in KAGE_TRUSTED_APPS. It goes into the env file, so it is one plain word.
export const validAppId = (id: string) => /^A[A-Z0-9]{2,}$/.test(id)

// Who a task counts as. Email never counts as the owner, whatever the task says: anyone may be behind
// a mailbox forward. A voice call is the strictest label (see voiceToolRefusal) unless the voice
// connector flagged it as the owner, which it does only for a call Kage placed (a one-time code).
export type Sender = 'owner' | 'teammate' | 'voice'
export const senderOf = (t: { fromOwner: boolean; meta: { channel: string } }): Sender =>
  t.meta.channel === 'voice' ? (t.fromOwner ? 'owner' : 'voice') : t.fromOwner && t.meta.channel !== 'email' ? 'owner' : 'teammate'

// Characters people never see but Claude reads: Unicode tag letters (whole hidden sentences), zero-width
// spaces, word joiners, byte-order marks, soft hyphens, direction overrides, filler letters, variation
// selectors and control codes. Kept, because real text needs them: the zero-width joiner and non-joiner
// (emoji, Indic and Persian words), the direction marks U+200E, U+200F and U+061C (mixed Arabic or
// Hebrew), U+FE0E and U+FE0F (emoji style), and tab and newline.
const INVISIBLE = /[\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}\u{1D173}-\u{1D17A}\u200B\u2060-\u2064\u206A-\u206F\uFEFF\u00AD\u034F\u180E\u17B4\u17B5\u115F\u1160\u3164\uFFA0\uFE00-\uFE0D\u202A-\u202E\u2066-\u2069\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/gu
export const withoutInvisible = (text: string) => text.replace(INVISIBLE, '')
