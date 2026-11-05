import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

// The folders the hub runs code from. A merge or an update changes a file in one of them.
const CODE_DIRS = ['.', 'core', 'connectors', 'runtime']

// The newest change to the code the hub runs: its .ts files (not tests) and package-lock.json.
// The hub restarts when this moves, so a merge or a reinstall is a deploy.
export function codeStamp(root: string): number {
  let newest = 0
  for (const dir of CODE_DIRS) {
    let names: string[]
    try { names = readdirSync(join(root, dir)) } catch { continue }
    for (const n of names) {
      if (!(n.endsWith('.ts') && !n.endsWith('.test.ts')) && !(dir === '.' && n === 'package-lock.json')) continue
      try { newest = Math.max(newest, statSync(join(root, dir, n)).mtimeMs) } catch { /* removed mid-scan */ }
    }
  }
  return newest
}
