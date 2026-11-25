const MAX = 120
const short = (s: string) => {
  const first = s.trim().split('\n')[0]!.trim()
  return first.length > MAX ? `${first.slice(0, MAX - 1)}…` : first
}
const REPLY_TOOL = /^mcp__(plugin_kage_)?kage__reply$/
const toolName = (name: string) => name.startsWith('mcp__') ? name.slice(name.lastIndexOf('__') + 2).replaceAll('_', ' ') : name

export function stepTime(raw: string): number | undefined {
  try {
    const t = Date.parse((JSON.parse(raw) as { timestamp?: string }).timestamp ?? '')
    return Number.isNaN(t) ? undefined : t
  } catch { return undefined }
}

export type Step = { kind: string; text: string }

export function transcriptSteps(raw: string): Step[] {
  let r: { type?: string; message?: { content?: unknown } }
  try { r = JSON.parse(raw) } catch { return [] }
  const content = r.message?.content
  if (r.type === 'user' && typeof content === 'string') {
    const m = /^<channel [^>]*>\n([^\n]*)/.exec(content)
    return [{ kind: m ? 'task' : 'input', text: short(m ? m[1]! : content) }]
  }
  if (!Array.isArray(content)) return []
  const out: Step[] = []
  for (const b of content as { type?: string; text?: string; name?: string; input?: Record<string, unknown>; is_error?: boolean; content?: unknown }[]) {
    if (r.type === 'assistant' && b.type === 'text' && b.text?.trim()) out.push({ kind: 'says', text: short(b.text) })
    else if (r.type === 'assistant' && b.type === 'tool_use' && b.name) {
      const i = b.input ?? {}
      if (REPLY_TOOL.test(b.name)) out.push({ kind: 'reply', text: short(String(i.text ?? '')) })
      else out.push({ kind: toolName(b.name), text: short(String(i.description ?? i.command ?? i.file_path ?? i.pattern ?? i.prompt ?? i.url ?? '')) })
    } else if (r.type === 'user' && b.type === 'tool_result' && b.is_error) {
      const c = b.content
      out.push({ kind: 'error', text: short(typeof c === 'string' ? c : Array.isArray(c) ? c.map(x => x?.text ?? '').join('') : '') })
    }
  }
  return out
}

export function transcriptLine(raw: string): string | undefined {
  const steps = transcriptSteps(raw)
  return steps.length ? steps.map(s => `${s.kind.padEnd(5)} ${s.text}`.trimEnd()).join('\n') : undefined
}

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


export function repliesIn(raw: string): { text: string; asksOwner?: string }[] {
  let r: { type?: string; message?: { content?: unknown } }
  try { r = JSON.parse(raw) } catch { return [] }
  if (r.type !== 'assistant' || !Array.isArray(r.message?.content)) return []
  return (r.message.content as { type?: string; name?: string; input?: { text?: unknown; waiting?: unknown; waiting_on?: unknown } }[]).flatMap(b => {
    if (b.type !== 'tool_use' || !REPLY_TOOL.test(b.name ?? '') || typeof b.input?.text !== 'string') return []
    const ask = typeof b.input.waiting === 'string' && b.input.waiting.trim() && b.input.waiting_on === 'owner' ? b.input.waiting.trim() : undefined
    return [{ text: b.input.text, ...ask && { asksOwner: ask } }]
  })
}
