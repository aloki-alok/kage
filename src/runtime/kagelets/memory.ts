import { randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { memoryPath, proposalFrom, type Proposal } from '../../core/kagelets/memory.ts'
import { NAME } from '../../core/kagelets/kagelet.ts'
import type { EventKind } from '../../core/events.ts'

type Decision = { kagelet: string; id: string; action: 'approve' | 'edit' | 'reject'; text?: string; reason?: string }
type Saved = Proposal & { id: string; at: number; thread: string }

type Options = {
  dir: string; forbid: () => string[]
  event: (e: { kind: EventKind; who: string; trace: string; detail: string }) => void
  waiting: (cells: string[]) => void
  newId?: () => string
}

const isDir = (p: string) => { try { const s = lstatSync(p); return s.isDirectory() && !s.isSymbolicLink() } catch { return false } }
const linked = (p: string) => { try { lstatSync(p); return true } catch { return false } }
const real = (p: string) => { try { return realpathSync(p) } catch { return undefined } }
const within = (p: string, d: string) => p === d || p.startsWith(`${d}/`)
const file = (path: string) => { try { const s = lstatSync(path); return s.isFile() && s.nlink === 1 } catch { return false } }

function folder(o: Options, name: string, create = false): { path: string } | { error: string } {
  const ok = memoryPath(o.dir, name, 'x.md', o.forbid())
  if ('error' in ok) return ok
  const kagelet = `${o.dir}/${name}`, mine = `${kagelet}/memory`
  const root = real(o.dir)
  if (create && root && o.forbid().some(f => { const r = real(f); return !!r && (within(root, r) || within(r, root)) })) return { error: `${o.dir} reaches Kage's or the owner's memory` }
  for (const p of [kagelet, mine]) {
    if (create && !linked(p)) mkdirSync(p, { mode: 0o700 })
    if (!isDir(p)) return { error: create ? `${p} is not a plain folder` : 'no folder' }
  }
  const at = real(mine), base = real(o.dir)
  if (!at || !base || at !== `${base}/${name}/memory` || o.forbid().some(f => { const r = real(f); return !!r && (within(at, r) || within(r, at)) })) return { error: `${mine} reaches outside the kagelets folder` }
  return { path: mine }
}

function proposals(o: Options, name: string): Saved[] {
  const f = folder(o, name)
  if ('error' in f || !isDir(`${f.path}/.proposals`)) return []
  return readdirSync(`${f.path}/.proposals`).filter(n => /^[a-z0-9]+\.json$/.test(n)).flatMap(n => { try { return [JSON.parse(readFileSync(`${f.path}/.proposals/${n}`, 'utf8')) as Saved] } catch { return [] } })
}
const names = (o: Options) => { try { return readdirSync(o.dir).filter(n => NAME.test(n) && isDir(`${o.dir}/${n}/memory`)).sort() } catch { return [] } }

function notes(o: Options, name: string): { file: string; text: string }[] {
  const f = folder(o, name)
  if ('error' in f) return []
  return readdirSync(f.path).filter(n => n.endsWith('.md') && !n.startsWith('.') && file(`${f.path}/${n}`)).sort().slice(0, 20)
    .map(n => ({ file: n, text: readFileSync(`${f.path}/${n}`, 'utf8').slice(0, 4000) }))
}

function propose(o: Options, name: string, a: { file?: unknown; text?: unknown; why?: unknown }, thread: string): string {
  const p = proposalFrom(a)
  if ('error' in p) return `not proposed: ${p.error}`
  const f = folder(o, name, true)
  if ('error' in f) return `not proposed: ${f.error}`
  const open = proposals(o, name)
  if (open.length >= 5) return 'not proposed: five proposals already wait for Kage'
  const id = (o.newId ?? (() => randomUUID().slice(0, 8)))()
  const dir = `${f.path}/.proposals`
  if (!linked(dir)) mkdirSync(dir, { mode: 0o700 })
  if (!isDir(dir)) return `not proposed: ${dir} is not a plain folder`
  writeFileSync(`${dir}/${id}.json`, JSON.stringify({ ...p, id, at: Date.now(), thread } satisfies Saved), { mode: 0o600 })
  o.event({ kind: 'memory-proposal', who: name, trace: '', detail: `${p.file}: ${p.why}` })
  o.waiting(['open', thread, '', `kagelet ${name} proposed a change to its memory (${p.file}): review it with review_kagelet_memory`])
  return `proposed ${p.file}. Kage reviews it; it applies only if approved.`
}

function decide(o: Options, d: Decision): string {
  if (!/^[a-z0-9]+$/.test(d.id)) return `no proposal "${d.id}"`
  const p = proposals(o, d.kagelet).find(x => x.id === d.id)
  if (!p) return `There is no proposal ${d.id} for ${d.kagelet}.`
  const f = folder(o, d.kagelet)
  if ('error' in f) return `refused: ${f.error}`
  const again = proposalFrom(p)
  if ('error' in again) return `not ${d.action === 'reject' ? 'rejected' : d.action === 'edit' ? 'edited' : 'approved'}: the saved proposal is not valid (${again.error})`
  const reason = (d.reason ?? '').trim()
  if (d.action === 'reject' && (!reason || reason.length > 200 || /[\r\n]/.test(reason))) return 'A rejection needs a one-line reason.'
  const text = d.action === 'edit' ? proposalFrom({ ...p, text: d.text }) : p
  if ('error' in text) return `not edited: ${text.error}`
  if (d.action !== 'reject') {
    const target = `${f.path}/${p.file}`
    if (existsSync(target) && !file(target)) return `refused: ${p.file} is not a plain file, so nothing was written`
    rmSync(`${target}.new`, { force: true })
    writeFileSync(`${target}.new`, text.text, { mode: 0o600, flag: 'wx' })
    renameSync(`${target}.new`, target)
  }
  unlinkSync(`${f.path}/.proposals/${p.id}.json`)
  const word = d.action === 'approve' ? 'approved' : d.action === 'edit' ? 'edited' : 'rejected'
  o.event({ kind: 'memory-decision', who: d.kagelet, trace: '', detail: `${word} ${p.file}${d.action === 'reject' ? `: ${reason}` : ''}` })
  return `${word} ${p.file} for ${d.kagelet}.`
}

export function kageletMemory(o: Options) {
  return {
    notes: (name: string) => notes(o, name),
    propose: (name: string, a: { file?: unknown; text?: unknown; why?: unknown }, thread: string) => propose(o, name, a, thread),
    open: (): string => {
      const all = names(o).flatMap(n => proposals(o, n).map(p => `${n} ${p.id}: ${p.file}, because ${p.why}\n${p.text}`))
      return all.length ? all.join('\n\n') : 'No memory proposals are waiting.'
    },
    decide: (d: Decision) => decide(o, d),
  }
}
