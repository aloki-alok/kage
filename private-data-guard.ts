// PreToolUse hook: inside a Kage thread, refuse private sources (mail, drive, calendar, meeting
// notes) unless the thread's latest task came from the owner. The server writes that sender file.
import { readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { privateToolRefusal, senderFile } from './logic.ts'

const thread = process.env.KAGE_THREAD
if (thread) {
  const { tool_name } = JSON.parse(readFileSync(0, 'utf8'))
  const dir = dirname(process.env.KAGE_ENV || `${process.env.HOME}/.config/kage/env`)
  let sender: string | undefined
  try { sender = readFileSync(senderFile(dir, thread), 'utf8').trim() } catch {}
  const reason = privateToolRefusal(tool_name, sender)
  if (reason) console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }))
}
