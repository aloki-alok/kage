
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
  return { send: `Your Slack app lacks ${what}, so some Kage features fail with missing_scope. Run \`kage slack upgrade\` in a terminal. It adds them to your app's manifest, keeps your other settings, and opens the page where you click Reinstall.`, told: set }
}

export const manifestUrl = (team: string, app: string) => `https://app.slack.com/app-settings/${team}/${app}/app-manifest`

export const installUrl = (app: string) => `https://api.slack.com/apps/${app}/install-on-team`

type Scopes = Record<string, unknown>
export type Manifest = Record<string, unknown> & { oauth_config: Record<string, unknown> & { scopes: Scopes } }

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isNames = (v: unknown): v is string[] => Array.isArray(v) && v.every(s => typeof s === 'string')

export function withScopes(manifest: unknown, m: Missing): Manifest | undefined {
  if (!isRecord(manifest) || !isRecord(manifest.oauth_config) || !isRecord(manifest.oauth_config.scopes)) return undefined
  const scopes: Scopes = { ...manifest.oauth_config.scopes }
  for (const k of KINDS) {
    const have = scopes[k] ?? []
    if (!isNames(have)) return undefined
    if (m[k].length) scopes[k] = [...new Set([...have, ...m[k]])]
  }
  return { ...manifest, oauth_config: { ...manifest.oauth_config, scopes } }
}

const reinstall = (n: number, where: string) => [
  `${n}. Click "Reinstall to Workspace"${where}, then click Allow.`,
  `${n + 1}. If Slack shows new tokens under Install App, run kage save to enter them.`,
]

export const upgradeSteps = (install: string) => [`1. Open ${install} if it did not open.`, ...reinstall(2, '')]

export function pasteSteps(m: Missing, url: string): string[] {
  const lists = KINDS.filter(k => m[k].length).flatMap(k => [`   After "${k}": [ paste:`, ...m[k].map(s => `       "${s}",`)])
  return [
    `1. Open ${url} if it did not open, and pick JSON.`,
    '2. Under "oauth_config" > "scopes", find each list below. Paste the lines under it on a new line right after its "[".',
    ...lists,
    '   If a list is [] or missing, write it as "user": ["a", "b"] with no comma after the last name.',
    '3. Click Save Changes.',
    ...reinstall(4, ' in the yellow banner'),
  ]
}
