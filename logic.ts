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
