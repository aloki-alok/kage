import { copyFileSync, statSync, truncateSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

export function rotate(log: string, max = 10 * 1024 * 1024) {
  try { if (statSync(log).size <= max) return } catch { return }
  copyFileSync(log, `${log}.1`)
  truncateSync(log, 0)
}

export const packagesStale = (dir: string) => {
  try { return statSync(`${dir}/package-lock.json`).mtimeMs >= statSync(`${dir}/node_modules/.package-lock.json`).mtimeMs } catch { return true }
}

export const npmCi = (dir: string) =>
  execFileSync('npm', ['ci', '--no-audit', '--no-fund', '--loglevel=error'], { cwd: dir, stdio: ['ignore', 'inherit', 'inherit'], timeout: 300_000 })
