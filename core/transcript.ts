// Turning a Claude Code session transcript line (JSONL) into a short line a person can follow.
// runtime/transcript-tail.ts reads the new lines from disk.
const MAX = 120
const short = (s: string) => {
  const first = s.trim().split('\n')[0]!.trim()
  return first.length > MAX ? `${first.slice(0, MAX - 1)}…` : first
}
const tag = (label: string, text: string) => `${label.padEnd(5)} ${short(text)}`.trimEnd()
// mcp__claude_ai_Slack__slack_read_thread reads as "slack read thread": the tool's own name, in words.
const toolName = (name: string) => name.startsWith('mcp__') ? name.slice(name.lastIndexOf('__') + 2).replaceAll('_', ' ') : name

// When the line was written, so a backlog shows when each step ran rather than when it was read.
export function stepTime(raw: string): number | undefined {
  try {
    const t = Date.parse((JSON.parse(raw) as { timestamp?: string }).timestamp ?? '')
    return Number.isNaN(t) ? undefined : t
  } catch { return undefined }
}

// What the task asked, what Kage said and did. Everything else gives undefined.
export function transcriptLine(raw: string): string | undefined {
  let r: { type?: string; message?: { content?: unknown } }
  try { r = JSON.parse(raw) } catch { return undefined }
  const content = r.message?.content
  if (r.type === 'user' && typeof content === 'string') {
    // A Kage task: the line after the channel tag is the instruction; the quoted conversation follows it.
    const m = /^<channel [^>]*>\n([^\n]*)/.exec(content)
    return tag(m ? 'task' : 'input', m ? m[1]! : content)   // input: a cron's prompt, or typed in a pane
  }
  if (!Array.isArray(content)) return undefined
  const out: string[] = []
  for (const b of content as { type?: string; text?: string; name?: string; input?: Record<string, unknown>; is_error?: boolean; content?: unknown }[]) {
    if (r.type === 'assistant' && b.type === 'text' && b.text?.trim()) out.push(tag('says', b.text))
    else if (r.type === 'assistant' && b.type === 'tool_use' && b.name) {
      const i = b.input ?? {}
      if (/^mcp__(plugin_kage_)?kage__reply$/.test(b.name)) out.push(tag('reply', String(i.text ?? '')))
      else out.push(tag(toolName(b.name), String(i.description ?? i.command ?? i.file_path ?? i.pattern ?? i.prompt ?? i.url ?? '')))
    } else if (r.type === 'user' && b.type === 'tool_result' && b.is_error) {
      const c = b.content
      out.push(tag('error', typeof c === 'string' ? c : Array.isArray(c) ? c.map(x => x?.text ?? '').join('') : ''))
    }
  }
  return out.length ? out.join('\n') : undefined
}

// The text of every post a session sent (its reply and post_as_kage calls), oldest first, read from its transcript lines.
export function sentTexts(lines: string[]): string[] {
  const out: string[] = []
  for (const raw of lines) {
    let r: { type?: string; message?: { content?: unknown } }
    try { r = JSON.parse(raw) } catch { continue }
    if (r.type !== 'assistant' || !Array.isArray(r.message?.content)) continue
    for (const b of r.message!.content as { type?: string; name?: string; input?: { text?: unknown } }[]) {
      if (b.type === 'tool_use' && /^mcp__(plugin_kage_)?kage__(reply|post_as_kage)$/.test(b.name ?? '') && typeof b.input?.text === 'string') out.push(b.input.text)
    }
  }
  return out
}
