
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
  attachments?: { title?: string; text?: string; fallback?: string; pretext?: string; fields?: { title?: string; value?: string }[] }[]
  blocks?: { block_id?: string }[]
  fromSocket?: true
}

export const filesTag = (m: { files?: { name?: string }[] }) =>
  m.files?.length ? ` [files: ${m.files.map(f => f.name).join(', ')}]` : ''

const TYPED_SUBTYPES = new Set([undefined, 'thread_broadcast', 'file_share'])

export const typedByPerson = (m: SlackMessage) =>
  (m.fromSocket || (!m.bot_id && !m.app_id && !!m.client_msg_id)) && TYPED_SUBTYPES.has(m.subtype)

export const postedByTrustedApp = (m: SlackMessage, apps: string[]) =>
  !!m.app_id && TYPED_SUBTYPES.has(m.subtype) && apps.some(a => {
    const e = appEntry(a)
    return !!e && e.id === m.app_id && (e.owner === undefined || e.owner === m.user)
  })

export const postedAsItself = (m: SlackMessage, apps: string[], teammates: string[]) =>
  !!m.app_id && TYPED_SUBTYPES.has(m.subtype) && apps.some(a => {
    const e = appEntry(a)
    return !!e && e.id === m.app_id && !!e.tag && e.tag === m.user && teammates.includes(e.owner ?? '')
  })

export const agentTag = (bot: string, name: string) =>
  new RegExp(`(?:<@${bot}>|(?<![\\w@.])@${name}(?![\\w.-]))[ \\t]?`, 'gi')

const blockStrings = (b: unknown): string[] => {
  if (Array.isArray(b)) return b.flatMap(blockStrings)
  if (!b || typeof b !== 'object') return []
  return Object.entries(b).flatMap(([k, v]) => k === 'text' && typeof v === 'string' ? [v] : blockStrings(v))
}

export function postText(m: Pick<SlackMessage, 'text' | 'attachments' | 'blocks'>): string {
  const parts = [m.text ?? '', ...(m.attachments ?? []).flatMap(a => {
    const own = [a.pretext, a.title, a.text, ...(a.fields ?? []).map(f => [f.title, f.value].filter(Boolean).join(': '))].filter(Boolean) as string[]
    return own.length ? own : [a.fallback ?? '']
  }), ...blockStrings(m.blocks)]
  return [...new Set(parts.flatMap(p => p.split('\n')).map(l => l.trimEnd()).filter(Boolean))].join('\n')
}
