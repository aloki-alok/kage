// The scopes the Slack app needs. cli/manifest.ts writes them into a new app's manifest, and the doctor and the hub
// compare them with what the installed app was granted: an app keeps the scopes of the manifest it was made from.

// The bot posts replies and approval prompts, and adds the pickup and done reactions.
export const BOT_SCOPES = ['chat:write', 'files:write', 'im:write', 'im:history', 'reactions:write', 'users:read']

// Your user token hears your conversations, reads the thread for context, and replies
// where the bot isn't a member.
export const USER_SCOPES = [
  'channels:history', 'groups:history', 'im:history', 'mpim:history',
  'channels:read', 'groups:read', 'im:read', 'mpim:read',
  'chat:write', 'reactions:write', 'users:read',
  // AFK mode sets your status while you are away, then puts the old one back.
  'users.profile:read', 'users.profile:write',
  // message_people opens the group DM of you and the people a task names.
  'im:write', 'mpim:write',
  // Sessions open files people attach in a thread.
  'files:read',
  // Sessions search Slack for the same subject in other channels before they answer.
  'search:read',
]

export type Missing = { bot: string[]; user: string[] }

export const missingScopes = (wanted: string[], granted: string[]) => [...new Set(wanted)].filter(s => !granted.includes(s))

const KINDS = ['bot', 'user'] as const

// The doctor's lines (the caller adds `ok` or `FAIL`).
export function scopeLines(m: Missing): { ok: boolean; text: string }[] {
  const lines = KINDS.filter(k => m[k].length).map(k => ({ ok: false, text: `the Slack app lacks ${k} scopes ${m[k].join(', ')}: run kage slack upgrade` }))
  return lines.length ? lines : [{ ok: true, text: 'the Slack app has every scope' }]
}

// The owner hears each distinct missing set once. `told` is the set last sent, kept by the hub so a restart does not repeat it.
export function scopeDm(m: Missing, told: string | undefined): { send?: string; told?: string } {
  const set = KINDS.flatMap(k => m[k].map(s => `${k}:${s}`)).join(',')
  if (!set) return { send: undefined, told: undefined }
  if (set === told) return { send: undefined, told }
  const what = KINDS.filter(k => m[k].length).map(k => `${k} scopes ${m[k].join(', ')}`).join(' and ')
  return { send: `Your Slack app lacks ${what}, so some Kage features fail with missing_scope. Run \`kage slack upgrade\` in a terminal to add them.`, told: set }
}
