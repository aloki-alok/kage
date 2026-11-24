import { hubKeyLine } from '../../core/doctor.ts'
import { askHub } from '../home.ts'
import type { Group } from './context.ts'

export const hubKey: Group = async () => {
  if (process.env.KAGE_SESSION || process.env.KAGE_THREAD) return []
  const answer = await askHub<{ refused?: unknown }>({ type: 'board' }, 3000).catch((e: Error) => e.message === 'down' ? 'down' as const : 'silent' as const)
  const line = hubKeyLine(answer)
  return line ? [line] : []
}
