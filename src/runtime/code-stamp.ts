import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const CODE_DIRS = ['.', 'plugin', 'src/hub', 'src/core', 'src/connectors', 'src/runtime']

export function codeStamp(root: string): number {
  let newest = 0
  const walk = (dir: string, top: boolean) => {
    let names: string[]
    try { names = readdirSync(join(root, dir)) } catch { return }
    for (const n of names) {
      const path = join(dir, n)
      if (!top && n !== 'tests' && n !== 'node_modules' && !n.startsWith('.')) try { if (statSync(join(root, path)).isDirectory()) { walk(path, false); continue } } catch { continue }
      if (!(n.endsWith('.ts') && !n.endsWith('.test.ts')) && !(dir === '.' && n === 'package-lock.json')) continue
      try { newest = Math.max(newest, statSync(join(root, path)).mtimeMs) } catch {  }
    }
  }
  for (const dir of CODE_DIRS) walk(dir, dir === '.')
  return newest
}
