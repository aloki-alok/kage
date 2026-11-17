// Who may ask a kagelet for work (ADR 0018 rule 0): its people line, and its owners line (up to 3 besides Kage's owner).
// Each is one line of Slack member ids: the front matter map keeps only the last of two, so a second line is refused.
import type { Kagelet } from './kagelets.ts'
import { validUserId } from './registry.ts'

const MAX_OWNERS = 3   // ponytail: fixed, a hub setting when an install needs more

export function idLine(frontMatter: string, head: Map<string, string>, key: 'people' | 'owners'): string[] | { error: string } {
  if (frontMatter.split('\n').filter(l => l.trim().startsWith(`${key}:`)).length > 1) return { error: `${key} must be one line` }
  const list = (head.get(key) ?? '').split(',').map(p => p.trim()).filter(Boolean)
  const odd = list.find(p => !validUserId(p))
  if (odd !== undefined) return { error: `${key} lists Slack member ids (U... or W...), not "${odd}"` }
  return key === 'owners' && list.length > MAX_OWNERS ? { error: `a kagelet has at most ${MAX_OWNERS} owners` } : list
}

// The kagelets that take asks in a thread: running, posting in exactly that thread, with a people or owners line.
// With name and from, only that kagelet, and only when from is on one of those lines.
export function askable(ks: Kagelet[], chat: string, thread: string, name?: string, from?: string): Kagelet[] {
  return ks.filter(k => !k.paused && (k.people || k.owners) && k.key.startsWith(`${chat}:${thread}#side-kagelet-`)
    && (name === undefined || (k.name === name && [...k.people ?? [], ...k.owners ?? []].includes(from ?? ''))))
}
