// The kagelets folder on disk (#57, ADR 0018): one folder per kagelet, its job.md and its memory/, and the paused line the owner flips.
// A kagelet's folder and its job.md are plain, never links, so no read, write, move or delete here leaves the kagelets folder.
import { lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { NAME, setPaused } from '../core/kagelets.ts'

// The kagelets folder.
export const kageletsDir = (dir: string) => `${dir}/kagelets`
// The one place a kagelet's file path is built. Its memory path is core/kagelet-memory.ts memoryPath.
export const jobPath = (dir: string, name: string) => `${dir}/${name}/job.md`

const stat = (p: string) => { try { return lstatSync(p) } catch { return undefined } }
const plainDir = (p: string) => { const s = stat(p); return !!s && s.isDirectory() && !s.isSymbolicLink() }
// A kagelet's folder, made when asked and nothing is there. False when it is a link or anything but a plain folder.
function ownFolder(dir: string, name: string, create = false) {
  if (!NAME.test(name)) return false
  if (create && !stat(`${dir}/${name}`)) { mkdirSync(dir, { recursive: true, mode: 0o700 }); mkdirSync(`${dir}/${name}`, { mode: 0o700 }) }
  return plainDir(`${dir}/${name}`)
}
// A kagelet that exists: a plain folder holding a plain job.md.
export const hasKagelet = (dir: string, name: string) => ownFolder(dir, name) && !!stat(jobPath(dir, name))?.isFile()

// Each kagelet folder's job.md. A missing folder is none, and a folder with no job.md is no kagelet.
export function readKagelets(dir: string) {
  let names: string[] = []
  try { names = readdirSync(dir).filter(f => hasKagelet(dir, f)) } catch {}
  // One file that cannot be read (removed mid-read) is left out, not the whole list.
  return names.flatMap(name => { try { return [{ name, text: readFileSync(jobPath(dir, name), 'utf8') }] } catch { return [] } })
}

// Write a kagelet's job.md: a fresh copy swapped in, so the hub never reads a half-written file, and a .new left as a link is never written through.
export function writeJob(dir: string, name: string, text: string) {
  if (!ownFolder(dir, name, true)) throw new Error(`${dir}/${name} is not a plain folder, so no kagelet is written there`)
  const file = jobPath(dir, name)
  rmSync(`${file}.new`, { force: true })
  writeFileSync(`${file}.new`, text, { mode: 0o600, flag: 'wx' })
  renameSync(`${file}.new`, file)
}

// kage stop <name>, the p key in kage top and the manager's tool: rewrite the paused line, keep the file.
// The hub's next sync (within a minute) applies it. Returns the line for a person.
export function pauseKagelet(dir: string, name: string, paused: boolean, now = Date.now()): string {
  if (!hasKagelet(dir, name)) return `There is no kagelet named "${name}".`
  const text = readFileSync(jobPath(dir, name), 'utf8')
  const next = setPaused(text, paused, now)
  if (next === text) return `${name} is already ${paused ? 'paused' : 'running'}.`
  writeJob(dir, name, next)
  return paused ? `${name} is paused within a minute. Its file stays; resume it to run it again.` : `${name} runs again within a minute, from its next scheduled time.`
}

// compat: remove after 2027-01-16
// The old layout (<name>.md, memory/<name>/) moves into one folder per kagelet. Run at each sync, so a move a crash cut
// short finishes, and a rerun changes nothing. Nothing moves through a link or into anything but a plain folder, a job.md
// already there wins, and one move that fails is skipped without stopping the rest or the sync.
export function migrateKagelets(dir: string) {
  const move = (from: string, name: string, to: string) => {
    try { if (!stat(to) && ownFolder(dir, name, true)) renameSync(from, to) } catch {}
  }
  const old = `${dir}/memory`
  if (plainDir(old)) for (const name of readdirSync(old).filter(n => NAME.test(n) && plainDir(`${old}/${n}`))) move(`${old}/${name}`, name, `${dir}/${name}/memory`)
  let files: string[] = []
  try { files = readdirSync(dir).filter(f => f.endsWith('.md') && NAME.test(f.slice(0, -3)) && !!stat(`${dir}/${f}`)?.isFile()) } catch {}
  for (const f of files) move(`${dir}/${f}`, f.slice(0, -3), jobPath(dir, f.slice(0, -3)))
}
