import { readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { envFilePath, readSettings } from '../runtime/config-files.ts'
import { memoryDirs, senderFile } from '../core/guards.ts'
import { toolRefusal } from '../runtime/path-guards.ts'
import { markTurn } from '../runtime/pane-turn.ts'

const thread = process.env.KAGE_THREAD
if (thread) {
  const { tool_name, tool_input } = JSON.parse(readFileSync(0, 'utf8'))
  const envFile = envFilePath()
  const dir = dirname(envFile)
  try { markTurn(dir, thread, 'step') } catch {}
  let harness, sharedTools
  try { ({ harness, sharedTools } = readSettings(envFile).config) } catch {}
  let sender: string | undefined
  try { sender = readFileSync(senderFile(dir, thread), 'utf8').trim() } catch {}
  const reason = toolRefusal(tool_name, tool_input ?? {}, sender, { ownerMemory: memoryDirs(process.env.HOME!, envFile, harness).owner, envFile, sharedTools })
  if (reason) console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }))
}
