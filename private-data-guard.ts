// PreToolUse hook: inside a Kage thread, refuse private sources (mail, drive, calendar, meeting
// notes) unless the thread's latest task came from the owner. The server writes that sender file.
// It also keeps the owner's memory read-only for Kage, except notes about people.
import { readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { memoryDirs, ownerMemoryRefusal, privateToolRefusal, senderFile, slackSendRefusal, voiceToolRefusal } from './core/guards.ts'

const thread = process.env.KAGE_THREAD
if (thread) {
  const { tool_name, tool_input } = JSON.parse(readFileSync(0, 'utf8'))
  const envFile = process.env.KAGE_ENV || `${process.env.HOME}/.config/kage/env`
  const dir = dirname(envFile)
  let sender: string | undefined
  try { sender = readFileSync(senderFile(dir, thread), 'utf8').trim() } catch {}
  // ponytail: this tmux route fails open (no sender file, no guard), so voice limits hold fully only on the SDK runtime.
  const reason = privateToolRefusal(tool_name, sender) ?? voiceToolRefusal(tool_name, sender) ?? slackSendRefusal(tool_name)
    ?? ownerMemoryRefusal(tool_name, tool_input ?? {}, memoryDirs(process.env.HOME!, envFile, process.env).owner)
  if (reason) console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }))
}
