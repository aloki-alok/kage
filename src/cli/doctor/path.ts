import { pathNote } from '../../core/doctor.ts'
import { onPath, type Group } from './context.ts'

export const path: Group = () => { const n = pathNote(onPath('kage')); return n ? [n] : [] }
