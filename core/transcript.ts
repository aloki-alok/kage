// Following a Claude Code session transcript (JSONL): read what was added, and turn each line into
// a short line a person can follow.
import { closeSync, openSync, readSync, statSync } from 'node:fs'

// The complete lines written after `offset`, and where the next read starts. A line still being
// written stays for the next read. A missing or unreadable file reads as nothing; a file shorter
// than the offset was replaced, so it is read from the top.
export function newLines(file: string, offset: number): { lines: string[]; offset: number } {
  let buf: Buffer
  try {
    const size = statSync(file).size
    if (size < offset) offset = 0
    if (size === offset) return { lines: [], offset }
    const fd = openSync(file, 'r')
    try {
      buf = Buffer.alloc(size - offset)
      buf = buf.subarray(0, readSync(fd, buf, 0, buf.length, offset))
    } finally { closeSync(fd) }
  } catch { return { lines: [], offset } }
  const end = buf.lastIndexOf(10)   // "\n"; never inside a multi-byte character
  if (end < 0) return { lines: [], offset }
  return { lines: buf.subarray(0, end).toString('utf8').split('\n').filter(Boolean), offset: offset + end + 1 }
}

// What the task asked, what Kage said and did. Everything else gives undefined.
const MAX = 120
const short = (s: string) => {
  const first = s.trim().split('\n')[0]!.trim()
  return first.length > MAX ? `${first.slice(0, MAX - 1)}…` : first
}
const tag = (label: string, text: string) => `${label.padEnd(5)} ${short(text)}`

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
      else out.push(tag(b.name.replace(/^mcp__(plugin_\w+?_)?/, ''), String(i.description ?? i.command ?? i.file_path ?? i.pattern ?? i.prompt ?? i.url ?? '')))
    } else if (r.type === 'user' && b.type === 'tool_result' && b.is_error) {
      const c = b.content
      out.push(tag('error', typeof c === 'string' ? c : Array.isArray(c) ? c.map(x => x?.text ?? '').join('') : ''))
    }
  }
  return out.length ? out.join('\n') : undefined
}
