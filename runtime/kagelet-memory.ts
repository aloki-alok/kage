// A kagelet's memory folder (core/kagelet-memory.ts) and the proposals waiting on Kage's review. The dream only
// proposes: a proposal is a file under .proposals/ that no prompt reads. A note lands in the folder only by decide(),
// which is Kage's tool, so the owner's session. No path here reaches Kage's or the owner's memory: the folder must be a
// real directory at exactly <kagelets>/memory/<name> (no link along the way), and a note must be a regular file.
import { randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { memoryPath, proposalFrom, type Proposal } from '../core/kagelet-memory.ts'
import { NAME } from '../core/kagelets.ts'
import type { EventKind } from '../core/events.ts'

type Decision = { kagelet: string; id: string; action: 'approve' | 'edit' | 'reject'; text?: string; reason?: string }
type Saved = Proposal & { id: string; at: number; thread: string }

export function kageletMemory(o: {
  dir: string; forbid: () => string[]
  event: (e: { kind: EventKind; who: string; trace: string; detail: string }) => void
  waiting: (cells: string[]) => void
  newId?: () => string
}) {
  const isDir = (p: string) => { try { const s = lstatSync(p); return s.isDirectory() && !s.isSymbolicLink() } catch { return false } }
  // lstat, so a dangling link counts as there and is never made over.
  const linked = (p: string) => { try { lstatSync(p); return true } catch { return false } }
  const real = (p: string) => { try { return realpathSync(p) } catch { return undefined } }
  const within = (p: string, d: string) => p === d || p.startsWith(`${d}/`)
  // The kagelet's folder when it is safe to use, else why not. create: make it (and only it) first.
  function folder(name: string, create = false): { path: string } | { error: string } {
    const ok = memoryPath(o.dir, name, 'x.md', o.forbid())
    if ('error' in ok) return ok
    const memory = `${o.dir}/memory`, mine = `${memory}/${name}`
    if (create) for (const p of [memory, mine]) if (!linked(p)) mkdirSync(p, { mode: 0o700 })
    if (!isDir(memory) || !isDir(mine)) return { error: create ? `${mine} is not a plain folder` : 'no folder' }
    const at = real(mine), base = real(o.dir)
    if (!at || !base || at !== `${base}/memory/${name}` || o.forbid().some(f => { const r = real(f); return !!r && (within(at, r) || within(r, at)) })) return { error: `${mine} reaches outside the kagelets folder` }
    return { path: mine }
  }
  const file = (path: string) => { try { return lstatSync(path).isFile() } catch { return false } }
  const proposals = (name: string): Saved[] => {
    const f = folder(name)
    if ('error' in f || !isDir(`${f.path}/.proposals`)) return []
    return readdirSync(`${f.path}/.proposals`).filter(n => /^[a-z0-9]+\.json$/.test(n)).flatMap(n => { try { return [JSON.parse(readFileSync(`${f.path}/.proposals/${n}`, 'utf8')) as Saved] } catch { return [] } })
  }
  const names = () => { try { return readdirSync(`${o.dir}/memory`).filter(n => NAME.test(n)).sort() } catch { return [] } }

  return {
    // The approved notes the kagelet reads: plain files only, never a link.
    notes(name: string): { file: string; text: string }[] {
      const f = folder(name)
      if ('error' in f) return []
      return readdirSync(f.path).filter(n => n.endsWith('.md') && !n.startsWith('.') && file(`${f.path}/${n}`)).sort().slice(0, 20)
        .map(n => ({ file: n, text: readFileSync(`${f.path}/${n}`, 'utf8').slice(0, 4000) }))
    },
    // From the dream lane of kagelet `name` (thread: its thread key). Kept for review, never applied.
    propose(name: string, a: { file?: unknown; text?: unknown; why?: unknown }, thread: string): string {
      const p = proposalFrom(a)
      if ('error' in p) return `not proposed: ${p.error}`
      const f = folder(name, true)
      if ('error' in f) return `not proposed: ${f.error}`
      const open = proposals(name)
      if (open.length >= 5) return 'not proposed: five proposals already wait for Kage'
      const id = (o.newId ?? (() => randomUUID().slice(0, 8)))()
      const dir = `${f.path}/.proposals`
      if (!isDir(dir)) mkdirSync(dir, { mode: 0o700 })
      writeFileSync(`${dir}/${id}.json`, JSON.stringify({ ...p, id, at: Date.now(), thread } satisfies Saved), { mode: 0o600 })
      o.event({ kind: 'memory-proposal', who: name, trace: '', detail: `${p.file}: ${p.why}` })
      o.waiting(['open', thread, '', `kagelet ${name} proposed a change to its memory (${p.file}): review it with review_kagelet_memory`])
      return `proposed ${p.file}. Kage reviews it; it applies only if approved.`
    },
    // Every proposal waiting, with its text, for Kage's review.
    open(): string {
      const all = names().flatMap(n => proposals(n).map(p => `${n} ${p.id}: ${p.file}, because ${p.why}\n${p.text}`))
      return all.length ? all.join('\n\n') : 'No memory proposals are waiting.'
    },
    // Kage's call on one proposal. Approve writes the proposal's text, edit writes Kage's, reject needs a reason.
    decide(d: Decision): string {
      if (!/^[a-z0-9]+$/.test(d.id)) return `no proposal "${d.id}"`
      const p = proposals(d.kagelet).find(x => x.id === d.id)
      if (!p) return `There is no proposal ${d.id} for ${d.kagelet}.`
      const f = folder(d.kagelet)
      if ('error' in f) return `refused: ${f.error}`
      const reason = (d.reason ?? '').trim()
      if (d.action === 'reject' && (!reason || reason.length > 200 || /[\r\n]/.test(reason))) return 'A rejection needs a one-line reason.'
      const text = d.action === 'edit' ? proposalFrom({ ...p, text: d.text })  : p
      if ('error' in text) return `not edited: ${text.error}`
      if (d.action !== 'reject') {
        const target = `${f.path}/${p.file}`
        if (existsSync(target) && !file(target)) return `refused: ${p.file} is not a plain file, so nothing was written`
        // A copy swapped in, so the kagelet never reads a half-written note.
        writeFileSync(`${target}.new`, text.text, { mode: 0o600 })
        renameSync(`${target}.new`, target)
      }
      unlinkSync(`${f.path}/.proposals/${p.id}.json`)
      const word = d.action === 'approve' ? 'approved' : d.action === 'edit' ? 'edited' : 'rejected'
      o.event({ kind: 'memory-decision', who: d.kagelet, trace: '', detail: `${word} ${p.file}${d.action === 'reject' ? `: ${reason}` : ''}` })
      return `${word} ${p.file} for ${d.kagelet}.`
    },
  }
}
