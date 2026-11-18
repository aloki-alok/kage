import { lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { NAME, setPaused } from '../core/kagelets.ts'

export const kageletsDir = (dir: string) => `${dir}/kagelets`
export const jobPath = (dir: string, name: string) => `${dir}/${name}/job.md`

const stat = (p: string) => { try { return lstatSync(p) } catch { return undefined } }
const plainDir = (p: string) => { const s = stat(p); return !!s && s.isDirectory() && !s.isSymbolicLink() }
function ownFolder(dir: string, name: string, create = false) {
  if (!NAME.test(name)) return false
  if (create && !stat(`${dir}/${name}`)) { mkdirSync(dir, { recursive: true, mode: 0o700 }); mkdirSync(`${dir}/${name}`, { mode: 0o700 }) }
  return plainDir(`${dir}/${name}`)
}
export const folderFree = (dir: string, name: string) => { const s = stat(`${dir}/${name}`); return !s || (s.isDirectory() && !s.isSymbolicLink()) }
export const hasKagelet = (dir: string, name: string) => ownFolder(dir, name) && !!stat(jobPath(dir, name))?.isFile()

export function readKagelets(dir: string) {
  let names: string[] = []
  try { names = readdirSync(dir).filter(f => hasKagelet(dir, f)) } catch {}
  return names.flatMap(name => { try { return [{ name, text: readFileSync(jobPath(dir, name), 'utf8') }] } catch { return [] } })
}

export function writeJob(dir: string, name: string, text: string) {
  if (!ownFolder(dir, name, true)) throw new Error(`${dir}/${name} is not a plain folder, so no kagelet is written there`)
  const file = jobPath(dir, name)
  rmSync(`${file}.new`, { force: true })
  writeFileSync(`${file}.new`, text, { mode: 0o600, flag: 'wx' })
  renameSync(`${file}.new`, file)
}

export function pauseKagelet(dir: string, name: string, paused: boolean, now = Date.now()): string {
  if (!hasKagelet(dir, name)) return `There is no kagelet named "${name}".`
  const text = readFileSync(jobPath(dir, name), 'utf8')
  const next = setPaused(text, paused, now)
  if (next === text) return `${name} is already ${paused ? 'paused' : 'running'}.`
  writeJob(dir, name, next)
  return paused ? `${name} is paused within a minute. Its file stays; resume it to run it again.` : `${name} runs again within a minute, from its next scheduled time.`
}

// compat: remove after 2027-01-16
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
