import type { Kagelet } from './kagelet.ts'
import { validUserId } from '../registry.ts'

export function idLine(frontMatter: string, head: Map<string, string>, key: 'people' | 'owners'): string[] | { error: string } {
  if (frontMatter.split('\n').filter(l => l.trim().startsWith(`${key}:`)).length > 1) return { error: `${key} must be one line` }
  const list = (head.get(key) ?? '').split(',').map(p => p.trim()).filter(Boolean)
  const odd = list.find(p => !validUserId(p))
  if (odd !== undefined) return { error: `${key} lists Slack member ids (U... or W...), not "${odd}"` }
  return list
}

export function askable(ks: Kagelet[], chat: string, thread: string, name?: string, from?: string): Kagelet[] {
  return ks.filter(k => !k.paused && (k.people || k.owners) && k.key.startsWith(`${chat}:${thread}#side-kagelet-`)
    && (name === undefined || (k.name === name && [...k.people ?? [], ...k.owners ?? []].includes(from ?? ''))))
}
