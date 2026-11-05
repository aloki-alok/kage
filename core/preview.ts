// What the owner reads before approving a tool call: the call the way a person would write it,
// not its JSON. A Bash command keeps its line breaks, an edit reads as a diff.
type Input = Record<string, unknown>

const diff = (old: unknown, now: unknown) => [
  ...String(old ?? '').split('\n').map(l => `- ${l}`),
  ...String(now ?? '').split('\n').map(l => `+ ${l}`),
].join('\n')

const field = ([k, v]: [string, unknown]) =>
  typeof v === 'string' ? `${k}: ${v.replaceAll('\n', '\n  ')}` : `${k}: ${JSON.stringify(v)}`

export function approvalPreview(tool: string, input: Input): string {
  if (tool === 'Bash') return String(input.command ?? '')
  if (tool === 'Edit') return `${input.file_path}\n${diff(input.old_string, input.new_string)}`
  if (tool === 'MultiEdit') {
    const edits = (input.edits ?? []) as Input[]
    return `${input.file_path}\n${edits.map(e => diff(e.old_string, e.new_string)).join('\n\n')}`
  }
  if (tool === 'Write') return `${input.file_path}\n${input.content ?? ''}`
  return Object.entries(input).map(field).join('\n')
}
