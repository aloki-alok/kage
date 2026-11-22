import { connectorStates, halfSetLines } from '../../core/connect.ts'
import { settings } from '../home.ts'
import type { Group } from './context.ts'

export const connect: Group = async () => halfSetLines(connectorStates(settings()))
