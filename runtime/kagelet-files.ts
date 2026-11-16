// The kagelets folder on disk (#57, ADR 0018): one folder per kagelet, its job.md and its memory/, and the paused line the owner flips.
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { NAME, setPaused } from '../core/kagelets.ts'

// The kagelets folder.
export const kageletsDir = (dir: string) => `${dir}/kagelets`
// The one place a kagelet's file path is built. Its memory path is core/kagelet-memory.ts memoryPath.
export const jobPath = (dir: string, name: string) => `${dir}/${name}/job.md`

// Each kagelet folder's job.md. A missing folder is none, and a folder with no job.md is no kagelet.
export function readKagelets(dir: string) {
  let names: string[] = []
  try { names = readdirSync(dir).filter(f => NAME.test(f)) } catch {}
  // One file that cannot be read (job.md a folder, a file removed mid-read) is left out, not the whole list.
  return names.flatMap(name => { try { return [{ name, text: readFileSync(jobPath(dir, name), 'utf8') }] } catch { return [] } })
}

// Write a kagelet's job.md: its folder first, then a copy swapped in, so the hub never reads a half-written file.
export function writeJob(dir: string, name: string, text: string) {
  mkdirSync(`${dir}/${name}`, { recursive: true, mode: 0o700 })
  const file = jobPath(dir, name)
  writeFileSync(`${file}.new`, text, { mode: 0o600 })
  renameSync(`${file}.new`, file)
}

// kage stop <name>, the p key in kage top and the manager's tool: rewrite the paused line, keep the file.
// The hub's next sync (within a minute) applies it. Returns the line for a person.
export function pauseKagelet(dir: string, name: string, paused: boolean, now = Date.now()): string {
  const file = jobPath(dir, name)
  if (!NAME.test(name) || !existsSync(file)) return `There is no kagelet named "${name}".`
  const text = readFileSync(file, 'utf8')
  const next = setPaused(text, paused, now)
  if (next === text) return `${name} is already ${paused ? 'paused' : 'running'}.`
  writeJob(dir, name, next)
  return paused ? `${name} is paused within a minute. Its file stays; resume it to run it again.` : `${name} runs again within a minute, from its next scheduled time.`
}

// compat: remove after 2027-01-16
// The old layout (<name>.md, memory/<name>/) moves into one folder per kagelet. Run at each sync, so a move a crash cut
// short finishes, and a rerun changes nothing. A link or anything but a plain folder is never moved or followed. A job.md
// that already exists wins: the old file is then left alone, and no read looks at it.
export function migrateKagelets(dir: string) {
  const plainDir = (p: string) => { try { const s = lstatSync(p); return s.isDirectory() && !s.isSymbolicLink() } catch { return false } }
  const old = `${dir}/memory`
  if (plainDir(old)) for (const name of readdirSync(old).filter(n => NAME.test(n))) {
    const to = `${dir}/${name}/memory`
    if (!plainDir(`${old}/${name}`) || existsSync(to)) continue
    mkdirSync(`${dir}/${name}`, { recursive: true, mode: 0o700 })
    renameSync(`${old}/${name}`, to)
  }
  let files: string[] = []
  try { files = readdirSync(dir).filter(f => f.endsWith('.md') && NAME.test(f.slice(0, -3))) } catch {}
  for (const f of files) {
    const name = f.slice(0, -3)
    if (existsSync(jobPath(dir, name)) || !lstatSync(`${dir}/${f}`).isFile()) continue
    mkdirSync(`${dir}/${name}`, { recursive: true, mode: 0o700 })
    renameSync(`${dir}/${f}`, jobPath(dir, name))
  }
}
