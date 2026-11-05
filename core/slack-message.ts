// A Slack message event, and the two questions both the task gate (gate.ts) and AFK mode (afk.ts) ask of it.

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

// Plain messages, threaded broadcasts and uploads. Edits, joins and deletes never count.
const TYPED_SUBTYPES = new Set([undefined, 'thread_broadcast', 'file_share'])

// A person typed it in a Slack client. An app posting with a person's user token (Kage's own reply
// fallback, a connector) has their user id but no client_msg_id, and usually an app_id.
export const typedByPerson = (m: SlackMessage) =>
  !m.bot_id && !m.app_id && !!m.client_msg_id && TYPED_SUBTYPES.has(m.subtype)

// A Slack mention of the bot, or "@name" typed as plain text (works whatever the bot's display name is).
// One optional space after it is part of the match, so removing the tag leaves no gap.
export const agentTag = (bot: string, name: string) =>
  new RegExp(`(?:<@${bot}>|(?<![\\w@.])@${name}(?![\\w.-]))[ \\t]?`, 'gi')
