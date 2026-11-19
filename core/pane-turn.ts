import { OWNER_AGAIN, OWNER_MID_TURN, senderOf, type Sender } from './gate.ts'
import type { Task } from './task.ts'

type PaneTurn = { open: boolean; tasks: { task: Task; at: number }[]; again: Task[] }
export const NO_TURN: PaneTurn = { open: false, tasks: [], again: [] }

const paneSender = (t: Task) => senderOf({ fromOwner: t.fromOwner === true, meta: t.meta })
export const turnSender = (turn: PaneTurn): Sender => turn.tasks.map(x => paneSender(x.task)).find(s => s !== 'owner') ?? 'owner'

export function arrive(turn: PaneTurn, task: Task, at: number): { turn: PaneTurn; shown: Task } {
  const next = { ...turn, open: true, tasks: [...turn.open ? turn.tasks : [], { task, at }] }
  const lowered = paneSender(task) === 'owner' && turnSender(next) !== 'owner'
  return { turn: next, shown: lowered ? { ...task, content: `${OWNER_MID_TURN}\n${task.content}` } : task }
}

export function endTurn(turn: PaneTurn, lastStep: number): { turn: PaneTurn; send: Task[] } {
  if (!turn.open) return { turn, send: [] }
  const carried = turn.tasks.filter(x => x.at > lastStep)
  const lowered = turnSender(turn) === 'owner' ? [] : turn.tasks.map(x => x.task).filter(t => paneSender(t) === 'owner' && !turn.again.includes(t))
  const again = [...turn.again, ...lowered]
  const ready = carried.every(x => paneSender(x.task) === 'owner')
  return {
    turn: { open: carried.length > 0, tasks: carried.length ? carried : turn.tasks, again: ready ? [] : again },
    send: ready ? again.map(t => t.content.startsWith(OWNER_AGAIN) ? t : { ...t, content: `${OWNER_AGAIN}\n${t.content}` }) : [],
  }
}
