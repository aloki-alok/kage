// The hub log and the packages, for hub.ts at start and router.ts while it runs. Node modules only: hub.ts must
// load even when the packages are broken.
import { copyFileSync, statSync, truncateSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

// The supervisor appends to hub.log and keeps it open, so the hub copies it aside and empties it in place.
export function rotate(log: string, max = 10 * 1024 * 1024) {
  try { if (statSync(log).size <= max) return } catch { return }
  copyFileSync(log, `${log}.1`)
  truncateSync(log, 0)
}

// Kage runs from its source, so its packages must match package-lock.json. npm stamps node_modules/.package-lock.json on each install.
export const packagesStale = (dir: string) => {
  try { return statSync(`${dir}/package-lock.json`).mtimeMs >= statSync(`${dir}/node_modules/.package-lock.json`).mtimeMs } catch { return true }
}

// Throws when npm fails or takes over 5 minutes. It blocks: callers run it only when nothing else needs the hub.
export const npmCi = (dir: string) =>
  execFileSync('npm', ['ci', '--no-audit', '--no-fund', '--loglevel=error'], { cwd: dir, stdio: ['ignore', 'inherit', 'inherit'], timeout: 300_000 })
