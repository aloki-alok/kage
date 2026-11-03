// Local slash commands: KAGE_COMMANDS="/lookup=/abs/path/script.mjs,...". The hub answers
// these itself for anyone in the workspace, without a Claude session. The only thing a caller
// controls is a list of phone numbers, so the script is the whole of what they can run.
export function parseCommands(value: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const entry of value.split(',').map(s => s.trim()).filter(Boolean)) {
    const m = /^(\/[a-z][a-z0-9-]{1,30})=(\/\S+)$/.exec(entry)
    if (!m) throw new Error(`KAGE_COMMANDS entry "${entry}" must look like /name=/absolute/path`)
    out.set(m[1]!, m[2]!)
  }
  return out
}

export type CommandRequest = { team_id?: string; user_id?: string; command?: string; text?: string }
export type CommandResult = { ok: true; script: string; numbers: string[] } | { ok: false; reply: string }

export function commandRequest(r: CommandRequest, o: { team: string; commands: Map<string, string> }): CommandResult {
  if (r.team_id !== o.team) return { ok: false, reply: 'This command works only for people in this workspace.' }
  const script = o.commands.get(r.command ?? '')
  if (!script) return { ok: false, reply: `${r.command} is not set up here.` }
  const tokens = (r.text ?? '').split(/[\s,]+/).filter(Boolean)
  if (!tokens.length) return { ok: false, reply: `Usage: ${r.command} 9876543210 9123456789 (no spaces inside a number)` }
  // Indian numbers only: 10 digits, optionally after +91, 91 or 0, with ( ) . - inside allowed.
  const ten = (t: string) => /^\+?[\d().-]+$/.test(t) ? /^(?:91|0)?(\d{10})$/.exec(t.replace(/\D/g, ''))?.[1] : undefined
  const bad = tokens.filter(t => !ten(t))
  if (bad.length) return { ok: false, reply: `Not Indian phone numbers: ${bad.slice(0, 5).join(' ')}. Send 10-digit numbers, no spaces inside a number.` }
  const numbers = [...new Set(tokens.map(t => ten(t)!))]
  return { ok: true, script, numbers }
}
