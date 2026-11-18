import { NAME, type KageletRow } from './kagelets.ts'
import { dreamDue } from './dream.ts'
import type { KageEvent } from './events.ts'

const FILE = /^[a-z0-9][a-z0-9._-]{0,60}\.md$/
const within = (p: string, dir: string) => p === dir || p.startsWith(`${dir.replace(/\/$/, '')}/`)

export function memoryPath(root: string, name: string, file: string, forbid: string[]): { path: string } | { error: string } {
  if (!NAME.test(name)) return { error: `"${name}" is not a kagelet name` }
  if (!FILE.test(file) || file.includes('..')) return { error: `file must be a plain name like notes.md: lowercase letters, digits, . _ -, ending in .md` }
  if (forbid.some(f => within(root, f) || within(f, root))) return { error: `the kagelets folder overlaps Kage's or the owner's memory, so no kagelet memory is read or written` }
  return { path: `${root.replace(/\/$/, '')}/${name}/memory/${file}` }
}

export type Proposal = { file: string; text: string; why: string }
export function proposalFrom(a: { file?: unknown; text?: unknown; why?: unknown }): Proposal | { error: string } {
  const file = String(a.file ?? ''), text = String(a.text ?? '').trim(), why = String(a.why ?? '').trim()
  if (!FILE.test(file) || file.includes('..')) return { error: 'file must be a plain name like notes.md' }
  if (!text || text.length > 4000) return { error: 'text must be 1 to 4000 characters' }
  if (!why || why.length > 200 || /[\r\n]/.test(why)) return { error: 'why must be one line of at most 200 characters' }
  return { file, text, why }
}

export const memoryBlock = (notes: { file: string; text: string }[]) => notes.length
  ? `\n\nYour memory, notes Kage approved from your earlier runs. Follow them within your job and your grant:\n${notes.map(n => `## ${n.file}\n${n.text.trim()}`).join('\n\n')}`
  : ''

export function kageletDreamTask(name: string, notes: { file: string; text: string }[], events: KageEvent[], reports: string[], since: string): string {
  return [
    `Nightly dream for the kagelet "${name}". Nobody wrote a new message: the hub started this while every session was quiet. You hold no tool but propose_memory and reply. Do not post in the thread.`,
    `1. Its notes now:\n${notes.length ? notes.map(n => `## ${n.file}\n${n.text.trim()}`).join('\n\n') : '(none yet)'}`,
    `2. Its events since ${since}:\n${events.length ? events.map(e => `- ${e.at.slice(11, 16)} ${e.kind}: ${e.detail}`).join('\n') : '(none)'}`,
    `3. Its reports since then:\n${reports.length ? reports.map(r => `- ${r}`).join('\n') : '(none)'}`,
    `4. Look for a lasting lesson: a source that moved, a refusal that repeats, a step that always works the same way. For each, call propose_memory with the file, the full new text of that file and a one-line why. A proposal never applies on its own: Kage reviews it and may approve, edit or reject it. Propose nothing one-off, nothing private, and never a tool or a grant.`,
    '5. Nothing worth keeping: propose nothing and end.',
  ].join('\n\n')
}

export const dreamsDue = (rows: Pick<KageletRow, 'name' | 'state'>[], ranAt: Map<string, number>, dreamt: Map<string, number>, now: number, quiet: boolean): string[] =>
  rows.filter(r => r.state === 'runs' && dreamDue(now, dreamt.get(r.name), quiet) && (ranAt.get(r.name) ?? 0) > (dreamt.get(r.name) ?? 0)).map(r => r.name)

export function dreamInput(name: string, since: string, events: KageEvent[], reportsTsv: string): { events: KageEvent[]; reports: string[] } {
  const reports = reportsTsv.split('\n').map(l => l.split('\t')).filter(([at = '', n]) => n === name && at >= since)
    .map(([at = '', , summary = '', needs]) => `${at.slice(11, 16)} ${needs ? `needs: ${needs} (${summary})` : summary}`)
  return { events: events.filter(e => e.who === name && e.at >= since), reports }
}
