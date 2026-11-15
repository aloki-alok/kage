// PreToolUse hook: inside a Kage thread, refuse private sources (mail, drive, calendar, meeting
// notes) unless the thread's latest task came from the owner. The server writes that sender file.
// It also keeps the owner's memory read-only for Kage, except notes about people.
import { readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { envFilePath, readSettings } from '../runtime/config-files.ts'
import { memoryDirs, senderFile } from '../core/guards.ts'
import { toolRefusal } from '../runtime/path-guards.ts'

const thread = process.env.KAGE_THREAD
if (thread) {
  const { tool_name, tool_input } = JSON.parse(readFileSync(0, 'utf8'))
  const envFile = envFilePath()
  const dir = dirname(envFile)
  let harness, sharedTools
  try { ({ harness, sharedTools } = readSettings(envFile).config) } catch {}   // no settings: the default memory folders
  let sender: string | undefined
  try { sender = readFileSync(senderFile(dir, thread), 'utf8').trim() } catch {}
  // No sender file reads as not the owner: every rule still runs, as for a teammate.
  const reason = toolRefusal(tool_name, tool_input ?? {}, sender, { ownerMemory: memoryDirs(process.env.HOME!, envFile, harness).owner, envFile, sharedTools })
  if (reason) console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }))
}
