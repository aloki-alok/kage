import { senderOf, teammateOf } from './gate.ts'
import type { Task } from './task.ts'
import { isOffSlack } from './conversations.ts'
import { oneLine } from './text.ts'

export const OFF_LIMITS = "This is off-limits for me, so I won't continue this conversation."
export const OWNER_BLOCKED = 'The safety check stopped my answer here, so I dropped it. Message me in this thread to start fresh.'

type BlockPlan = { reply?: string; dm?: string; close: boolean }

export const answersInThread = (t: Task) => !!t.origin.ts && !isOffSlack(t.meta.channel)

export const blockedTask = (turn: Task[]) => turn.find(x => senderOf(x) !== 'owner') ?? turn.at(-1)

export const TEAMMATE_DROPPED = 'A check on my machine stopped this message before I read it, so nothing ran. Please send it again in a bit.'

const askOf = (t: Task | undefined) => t?.content.replace(/^(Teammate task \(.*?, not the owner\)|Task from .*?): /, '').split('\n\nConversation so far')[0]!.slice(0, 400)
const placeOf = (t: Task | undefined) => t ? (t.meta.permalink ? `<${t.meta.permalink}|${t.meta.place}>` : t.meta.place) : 'a thread'

export function planDrop(turn: Task[], reason: string): { reply?: string; dm?: string } {
  const t = blockedTask(turn)
  const plain = oneLine(reason).slice(0, 500).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const said = plain ? `It said: “${plain}”` : 'It gave no reason.'
  const owner = !!t && senderOf(t) === 'owner'
  const inThread = !!t && answersInThread(t)
  if (owner && inThread) return { reply: `A hook on this machine stopped your message before I read it, so nothing ran. ${said}` }
  const who = t && !owner ? teammateOf(t.content) : undefined
  const ask = askOf(t)
  const dm = [
    `*A hook stopped a task before it ran* in ${placeOf(t)}. ${said}`,
    ...(ask ? [`${who ? who.name : 'The task'} asked: “${ask}”`] : []),
    'If the hook is from a plugin meant for your own terminal, add it to `harness.pluginsOff` to keep it out of Kage sessions.',
  ].join('\n')
  return { ...(inThread && { reply: TEAMMATE_DROPPED }), dm }
}

export function planBlock(turn: Task[], category: string | null): BlockPlan {
  const t = blockedTask(turn)
  const owner = t ? senderOf(t) === 'owner' : false
  const inThread = !!t && answersInThread(t)
  const reply = inThread ? (owner ? OWNER_BLOCKED : OFF_LIMITS) : undefined
  if (owner && inThread) return { reply, close: false }
  const close = !owner && inThread
  const who = t && teammateOf(t.content)
  const ask = askOf(t)
  const place = placeOf(t)
  const dm = [
    `*The safety check stopped a turn* in ${place}${category ? ` (${category})` : ''}.`,
    ...(ask ? [`${who ? who.name : 'The task'} asked: “${ask}”`] : []),
    close ? `I replied “${OFF_LIMITS}” and closed the thread to teammates. Reply in it to reopen it.` : 'Nothing was posted. The next message there starts fresh.',
  ].join('\n')
  return { ...(reply && { reply }), dm, close }
}
