import { copyFileSync, existsSync, readFileSync, rmSync, statSync, truncateSync, writeFileSync } from 'node:fs'
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

type ExitCause = 'update' | 'settings' | 'restart' | 'crash'

export function noteExit(dir: string, cause: ExitCause, error?: unknown) {
  const line = error instanceof Error ? `${error.name}: ${error.message}` : error === undefined ? '' : String(error)
  try { writeFileSync(`${dir}/exit-cause`, `${cause} ${line.split('\n')[0]!.slice(0, 160)}`.trim()) } catch {}
}

export function countBoot(dir: string, now: number): number {
  const file = `${dir}/boots`
  let cause = existsSync(file) ? 'unknown' : 'first'
  try { cause = readFileSync(`${dir}/exit-cause`, 'utf8').trim() || cause; rmSync(`${dir}/exit-cause`) } catch {}
  let lines: string[] = []
  try { lines = readFileSync(file, 'utf8').split('\n').filter(l => l && Number(l.split(' ')[0]) > now - 86_400) } catch {}
  lines.push(`${now} ${cause}`)
  writeFileSync(file, lines.join('\n') + '\n')
  return lines.filter(l => Number(l.split(' ')[0]) > now - 600).length
}
