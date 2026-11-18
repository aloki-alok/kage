// Whether a lead gets a reply now, and whether it leaves or stays a draft. Pure: the server passes the clock.
import type { MetaEvent } from './meta.ts'

export type Mode = 'off' | 'dry' | 'team' | 'live'
export type Thread = { day: string; repliesToday: number; humanAt?: number }
export type Limits = { repliesPerLeadPerDay: number; humanQuietHours: number }
export type Decision =
  | { act: 'reply' }
  | { act: 'human' }
  | { act: 'skip'; why: 'our_echo' | 'human_took_over' | 'over_limit' }

export const threadKey = (ev: MetaEvent) => `${ev.channel}:${ev.pageId}:${ev.user}`
export const dayOf = (at: number) => new Date(at).toISOString().slice(0, 10)

export function decide(ev: MetaEvent, t: Thread | undefined, now: number, ourAppId: string, l: Limits): Decision {
  // An echo is a message the Page sent. Ours we ignore; anyone else's means a person answered in the Meta inbox.
  if (ev.kind === 'echo') return ev.appId === ourAppId ? { act: 'skip', why: 'our_echo' } : { act: 'human' }
  if (t?.humanAt !== undefined && now - t.humanAt < l.humanQuietHours * 3_600_000) return { act: 'skip', why: 'human_took_over' }
  const today = t && t.day === dayOf(now) ? t.repliesToday : 0
  if (today >= l.repliesPerLeadPerDay) return { act: 'skip', why: 'over_limit' }
  return { act: 'reply' }
}

// Only `live` sends to anyone. `team` sends to the listed testers and drafts the rest; `dry` drafts everything.
export const sendsTo = (mode: Mode, user: string, team: readonly string[]) =>
  mode === 'live' || (mode === 'team' && team.includes(user))

// The thread after the bot answered once more.
export const counted = (t: Thread | undefined, now: number): Thread =>
  ({ ...t, day: dayOf(now), repliesToday: (t && t.day === dayOf(now) ? t.repliesToday : 0) + 1 })
