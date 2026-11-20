import { readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { envFilePath } from '../runtime/config-files.ts'
import { markTurn } from '../runtime/pane-turn.ts'

const thread = process.env.KAGE_THREAD
const transcript = (() => { try { return (JSON.parse(readFileSync(0, 'utf8')) as { transcript_path?: string }).transcript_path } catch { return undefined } })()
if (thread) try { markTurn(dirname(envFilePath()), thread, 'stop', transcript) } catch {}
