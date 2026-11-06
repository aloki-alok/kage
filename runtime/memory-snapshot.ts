// The hub's own copy of Kage's memory before a dream, so a bad merge is one command from undone
// (`kage dream undo`). The archive is left out of the copy and never touched by an undo.
import { execFileSync } from 'node:child_process'
import { mkdirSync, readdirSync, renameSync } from 'node:fs'

const stamp = (now: number) => new Date(now).toISOString().replace(/[:.]/g, '-')

export function snapshotMemory(dir: string, now: number): string {
  mkdirSync(`${dir}/.archive/snapshots`, { recursive: true })
  const file = `${dir}/.archive/snapshots/${stamp(now)}.tgz`
  execFileSync('tar', ['-czf', file, '--exclude', './.archive', '-C', dir, '.'])
  return file
}

// Back to the newest snapshot. What the memory held until now moves to .archive/undone-<time>/, never deleted.
export function undoToSnapshot(dir: string, now: number): string | undefined {
  let snaps: string[] = []
  try { snaps = readdirSync(`${dir}/.archive/snapshots`).filter(n => n.endsWith('.tgz')).sort() } catch {}
  const latest = snaps.at(-1)
  if (!latest) return undefined
  const aside = `${dir}/.archive/undone-${stamp(now)}`
  mkdirSync(aside, { recursive: true })
  for (const name of readdirSync(dir)) if (name !== '.archive') renameSync(`${dir}/${name}`, `${aside}/${name}`)
  const file = `${dir}/.archive/snapshots/${latest}`
  execFileSync('tar', ['-xzf', file, '-C', dir])
  return file
}
