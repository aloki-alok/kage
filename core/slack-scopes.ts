// The scopes the Slack app needs. cli/manifest.ts writes them into a new app's manifest, and the doctor and the hub
// compare them with what the installed app was granted: an app keeps the scopes of the manifest it was made from.

// The bot posts replies and approval prompts, and adds the pickup and done reactions. canvases:write: make_canvas and edit_canvas.
export const BOT_SCOPES = ['chat:write', 'files:write', 'im:write', 'im:history', 'reactions:write', 'users:read', 'canvases:write']

// Your user token hears your conversations, reads the thread for context, and replies
// where the bot isn't a member.
export const USER_SCOPES = [
  'channels:history', 'groups:history', 'im:history', 'mpim:history',
  'channels:read', 'groups:read', 'im:read', 'mpim:read',
  // The verified owner's voice call searches Slack without discovering an external tool first.
  'search:read',
  'chat:write', 'reactions:write', 'users:read',
  // kage add <email> finds the person with users.lookupByEmail (cli/registry.ts).
  'users:read.email',
  // AFK mode sets your status while you are away, then puts the old one back.
  'users.profile:read', 'users.profile:write',
  // message_people opens the group DM of you and the people a task names.
  'im:write', 'mpim:write',
  // The hub downloads files people attach to a task (runtime/slack-files.ts).
  'files:read',
]

import type { Line } from './doctor.ts'

export type Missing = { bot: string[]; user: string[] }

export const missingScopes = (wanted: string[], granted: string[]) => [...new Set(wanted)].filter(s => !granted.includes(s))

const KINDS = ['bot', 'user'] as const

// The doctor's lines (core/doctor.ts adds `ok` or `FAIL`).
export function scopeLines(m: Missing): Line[] {
  const lines = KINDS.filter(k => m[k].length).map(k => ({ kind: 'fail' as const, text: `the Slack app lacks ${k} scopes ${m[k].join(', ')}: run kage slack upgrade` }))
  return lines.length ? lines : [{ kind: 'ok', text: 'the Slack app has every scope' }]
}

// The owner hears each distinct missing set once. `told` is the set last sent, kept by the hub so a restart does not repeat it.
export function scopeDm(m: Missing, told: string | undefined): { send?: string; told?: string } {
  const set = KINDS.flatMap(k => m[k].map(s => `${k}:${s}`)).join(',')
  if (!set) return { send: undefined, told: undefined }
  if (set === told) return { send: undefined, told }
  const what = KINDS.filter(k => m[k].length).map(k => `${k} scopes ${m[k].join(', ')}`).join(' and ')
  return { send: `Your Slack app lacks ${what}, so some Kage features fail with missing_scope. Run \`kage slack upgrade\` in a terminal. It opens your app's manifest and names the scopes to add. Your other settings stay as they are.`, told: set }
}

// The app's manifest page in Slack's app settings (the same deep link the Slack CLI uses for the logs page).
export const manifestUrl = (team: string, app: string) => `https://app.slack.com/app-settings/${team}/${app}/app-manifest`

// What the person does. Only the missing names are added, so a customized app (own slash commands, interactivity,
// extra scopes) keeps everything it has. Pasting our whole manifest over theirs would wipe those.
export function upgradeSteps(m: Missing, url: string): string[] {
  const adds = KINDS.filter(k => m[k].length).map(k => `   - oauth_config.scopes.${k}: add ${m[k].join(', ')}`)
  return [
    `1. Open ${url} if it did not open.`,
    '2. In the manifest, add only these scope names to the lists that exist. Do not paste a whole manifest over yours.',
    ...adds,
    '3. Click Save Changes.',
    '4. Click "Reinstall to Workspace" in the yellow banner, then click Allow.',
    '5. If Slack shows new tokens under Install App, run kage save to enter them.',
  ]
}
