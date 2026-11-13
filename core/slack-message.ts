// A Slack message event, and the two questions both the task gate (gate.ts) and AFK mode (afk.ts) ask of it.

import { appEntry } from './registry.ts'

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
  files?: { name?: string }[]
}

// Claude sees no attachment unless the text names it; it then reads the file with the Slack tools.
export const filesTag = (m: { files?: { name?: string }[] }) =>
  m.files?.length ? ` [files: ${m.files.map(f => f.name).join(', ')}]` : ''

// Plain messages, threaded broadcasts and uploads. Edits, joins and deletes never count.
const TYPED_SUBTYPES = new Set([undefined, 'thread_broadcast', 'file_share'])

// A person typed it in a Slack client. An app posting with a person's user token (Kage's own reply
// fallback, a connector) has their user id but no client_msg_id, and usually an app_id.
export const typedByPerson = (m: SlackMessage) =>
  !m.bot_id && !m.app_id && !!m.client_msg_id && TYPED_SUBTYPES.has(m.subtype)

// A listed agent (KAGE_TRUSTED_APPS, core/registry.ts) posting with a teammate's token: it has an app_id
// and no client_msg_id. The gate still checks the user id, and never lets it act as the owner. An agent tied
// to a person counts only with that person's token. One with no owner was listed before owners existed, and
// counts with any listed teammate's. One owned by another agent does not count here.
export const postedByTrustedApp = (m: SlackMessage, apps: string[]) =>
  !!m.app_id && TYPED_SUBTYPES.has(m.subtype) && apps.some(a => {
    const e = appEntry(a)
    return !!e && e.id === m.app_id && (e.owner === undefined || e.owner === m.user)
  })

// A Slack mention of the bot, or "@name" typed as plain text (works whatever the bot's display name is).
// One optional space after it is part of the match, so removing the tag leaves no gap.
export const agentTag = (bot: string, name: string) =>
  new RegExp(`(?:<@${bot}>|(?<![\\w@.])@${name}(?![\\w.-]))[ \\t]?`, 'gi')
