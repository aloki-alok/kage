import { senderOf, teammateOf } from './gate.ts'
import type { Task } from './task.ts'

export const OFF_LIMITS = "This is off-limits for me, so I won't continue this conversation."
export const OWNER_BLOCKED = 'The safety check stopped my answer here, so I dropped it. Message me in this thread to start fresh.'

type BlockPlan = { reply?: string; dm?: string; close: boolean }

export const answersInThread = (t: Task) => !!t.origin.ts && !['email', 'whatsapp', 'voice'].includes(t.meta.channel)

export const blockedTask = (turn: Task[]) => turn.find(x => senderOf(x) !== 'owner') ?? turn.at(-1)

export function planBlock(turn: Task[], category: string | null): BlockPlan {
  const t = blockedTask(turn)
  const owner = t ? senderOf(t) === 'owner' : false
  const inThread = !!t && answersInThread(t)
  const reply = inThread ? (owner ? OWNER_BLOCKED : OFF_LIMITS) : undefined
  if (owner && inThread) return { reply, close: false }
  const close = !owner && inThread
  const who = t && teammateOf(t.content)
  const ask = t?.content.replace(/^(Teammate task \(.*?, not the owner\)|Task from .*?): /, '').split('\n\nConversation so far')[0]!.slice(0, 400)
  const place = t ? (t.meta.permalink ? `<${t.meta.permalink}|${t.meta.place}>` : t.meta.place) : 'a thread'
  const dm = [
    `*The safety check stopped a turn* in ${place}${category ? ` (${category})` : ''}.`,
    ...(ask ? [`${who ? who.name : 'The task'} asked: “${ask}”`] : []),
    close ? `I replied “${OFF_LIMITS}” and closed the thread to teammates. Reply in it to reopen it.` : 'Nothing was posted. The next message there starts fresh.',
  ].join('\n')
  return { ...(reply && { reply }), dm, close }
}
