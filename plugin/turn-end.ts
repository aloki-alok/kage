import { dirname } from 'node:path'
import { envFilePath } from '../runtime/config-files.ts'
import { markTurn } from '../runtime/pane-turn.ts'

const thread = process.env.KAGE_THREAD
if (thread) try { markTurn(dirname(envFilePath()), thread, 'stop') } catch {}
