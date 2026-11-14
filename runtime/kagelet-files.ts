// The kagelets folder on disk (#57): where it is, its .md files, and the paused line the owner flips.
import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { NAME, setPaused } from '../core/kagelets.ts'

// The kagelets folder.
export const kageletsDir = (dir: string) => `${dir}/kagelets`

// The folder's .md files. A missing folder is none.
export function readKagelets(dir: string) {
  let names: string[] = []
  try { names = readdirSync(dir).filter(f => f.endsWith('.md')) } catch {}
  // One file that cannot be read (a folder named x.md, a file removed mid-read) is left out, not the whole list.
  return names.flatMap(f => { try { return [{ name: f.slice(0, -3), text: readFileSync(`${dir}/${f}`, 'utf8') }] } catch { return [] } })
}

// kage stop <name>, the p key in kage top and the manager's tool: rewrite the paused line, keep the file.
// The hub's next sync (within a minute) applies it. Returns the line for a person.
export function pauseKagelet(dir: string, name: string, paused: boolean, now = Date.now()): string {
  const file = `${dir}/${name}.md`
  if (!NAME.test(name) || !existsSync(file)) return `There is no kagelet named "${name}".`
  const text = readFileSync(file, 'utf8')
  const next = setPaused(text, paused, now)
  if (next === text) return `${name} is already ${paused ? 'paused' : 'running'}.`
  // A copy swapped in, so the hub never reads a half-written file.
  writeFileSync(`${file}.new`, next, { mode: 0o600 })
  renameSync(`${file}.new`, file)
  return paused ? `${name} is paused within a minute. Its file stays; resume it to run it again.` : `${name} runs again within a minute, from its next scheduled time.`
}
