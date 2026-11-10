// When Anthropic's safety check stops a turn: what goes in the thread, what the owner hears, and
// whether the thread closes to teammates. A stopped session stays flagged, so the hub also starts the
// thread on a new session (Dispatcher.reset). Nothing retries on another model: the owner decides.
import { senderOf, teammateOf } from './gate.ts'
import type { Task } from '../runtime/protocol.ts'

// Never says who closed it or why, so it gives the asker nothing to work around.
export const OFF_LIMITS = "This is off-limits for me, so I won't continue this conversation."
export const OWNER_BLOCKED = 'The safety check stopped my answer here, so I dropped it. Message me in this thread to start fresh.'

export type BlockPlan = { reply?: string; dm?: string; close: boolean }

// A thread line only answers a Slack message: a schedule has none, and email, WhatsApp and voice reply in their own way.
export const answersInThread = (t: Task) => !!t.origin.ts && !['email', 'whatsapp', 'voice'].includes(t.meta.channel)

export function planBlock(t: Task | undefined, category: string | null): BlockPlan {
  const owner = t ? senderOf(t) === 'owner' : false
  const inThread = !!t && answersInThread(t)
  const reply = inThread ? (owner ? OWNER_BLOCKED : OFF_LIMITS) : undefined
  if (owner && inThread) return { reply, close: false }
  const who = t && teammateOf(t.content)
  const ask = t?.content.replace(/^(Teammate task \(.*?, not the owner\)|Task from .*?): /, '').split('\n\nConversation so far')[0]!.slice(0, 400)
  const place = t ? (t.meta.permalink ? `<${t.meta.permalink}|${t.meta.place}>` : t.meta.place) : 'a thread'
  const dm = [
    `*The safety check stopped a turn* in ${place}${category ? ` (${category})` : ''}.`,
    ...(ask ? [`${who ? who.name : 'The task'} asked: “${ask}”`] : []),
    owner ? 'Nothing was posted.' : `I replied “${OFF_LIMITS}” and closed the thread to teammates. Reply in it to reopen it.`,
  ].join('\n')
  return { ...(reply && { reply }), dm, close: !owner }
}
