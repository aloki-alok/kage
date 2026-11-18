
export const BOT_SCOPES = ['chat:write', 'files:write', 'im:write', 'im:history', 'reactions:write', 'users:read', 'canvases:write',
  'reactions:read']

export const USER_SCOPES = [
  'channels:history', 'groups:history', 'im:history', 'mpim:history',
  'channels:read', 'groups:read', 'im:read', 'mpim:read',
  'search:read',
  'chat:write', 'reactions:write', 'users:read',
  'users:read.email',
  'users.profile:read', 'users.profile:write',
  'im:write', 'mpim:write',
  'files:read',
  'reactions:read', 'pins:read', 'bookmarks:read', 'usergroups:read', 'team:read', 'dnd:read', 'canvases:read', 'lists:read',
]

import type { Line } from './doctor.ts'

export type Missing = { bot: string[]; user: string[] }

export const missingScopes = (wanted: string[], granted: string[]) => [...new Set(wanted)].filter(s => !granted.includes(s))

const KINDS = ['bot', 'user'] as const

export function scopeLines(m: Missing): Line[] {
  const lines = KINDS.filter(k => m[k].length).map(k => ({ kind: 'fail' as const, text: `the Slack app lacks ${k} scopes ${m[k].join(', ')}: run kage slack upgrade` }))
  return lines.length ? lines : [{ kind: 'ok', text: 'the Slack app has every scope' }]
}

export function scopeDm(m: Missing, told: string | undefined): { send?: string; told?: string } {
  const set = KINDS.flatMap(k => m[k].map(s => `${k}:${s}`)).join(',')
  if (!set) return { send: undefined, told: undefined }
  if (set === told) return { send: undefined, told }
  const what = KINDS.filter(k => m[k].length).map(k => `${k} scopes ${m[k].join(', ')}`).join(' and ')
  return { send: `Your Slack app lacks ${what}, so some Kage features fail with missing_scope. Run \`kage slack upgrade\` in a terminal. It opens your app's manifest and names the scopes to add. Your other settings stay as they are.`, told: set }
}

export const manifestUrl = (team: string, app: string) => `https://app.slack.com/app-settings/${team}/${app}/app-manifest`

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
