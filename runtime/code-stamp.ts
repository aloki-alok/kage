import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const CODE_DIRS = ['.', 'hub', 'plugin', 'core', 'connectors', 'runtime']

export function codeStamp(root: string): number {
  let newest = 0
  for (const dir of CODE_DIRS) {
    let names: string[]
    try { names = readdirSync(join(root, dir)) } catch { continue }
    for (const n of names) {
      if (!(n.endsWith('.ts') && !n.endsWith('.test.ts')) && !(dir === '.' && n === 'package-lock.json')) continue
      try { newest = Math.max(newest, statSync(join(root, dir, n)).mtimeMs) } catch {  }
    }
  }
  return newest
}
