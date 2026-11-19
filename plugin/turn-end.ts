import { writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { envFilePath } from '../runtime/config-files.ts'
import { turnMarks } from '../runtime/pane-turn.ts'

const thread = process.env.KAGE_THREAD
if (thread) try { writeFileSync(turnMarks(dirname(envFilePath()), thread).stop, String(Date.now()), { mode: 0o600 }) } catch {}
