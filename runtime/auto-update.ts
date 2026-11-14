// The git side of auto-update and the version line. The decision is core/auto-update.ts; these calls stay thin.
import { execFile, execFileSync } from 'node:child_process'
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { compareUrl, nextStep, type Checkout } from '../core/auto-update.ts'

// Async, so a slow fetch never stalls the hub's Slack socket.
const git = async (root: string, ...args: string[]) =>
  (await promisify(execFile)('git', args, { cwd: root, encoding: 'utf8', timeout: 60_000 })).stdout.trim()
const gitNow = (root: string, ...args: string[]) =>
  execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
// A .git of the folder's own: the code may sit inside someone's bigger repo (a dotfiles home), which is never pulled.
const isCheckout = (root: string) => existsSync(join(root, '.git'))

// The code in root as people read it: short sha and commit date, like "2ae579e (2026-11-14)".
export function version(root: string): string {
  if (!isCheckout(root)) return 'unknown (not a git checkout)'
  try { const [sha, date] = gitNow(root, 'log', '-1', '--format=%h %cs').split(' '); return `${sha} (${date})` }
  catch { return 'unknown (git log failed)' }
}

// Fast-forward a clean main to origin/main. Untracked files do not count as changes: a merge that would
// overwrite one fails on its own.
export async function pullMain(root: string): Promise<'pulled' | 'current' | { skip: string }> {
  const c: Checkout = { git: isCheckout(root) }
  if (c.git) {
    c.branch = await git(root, 'rev-parse', '--abbrev-ref', 'HEAD')
    c.dirty = await git(root, 'status', '--porcelain', '--untracked-files=no') !== ''
  }
  const before = nextStep(c)
  if (typeof before === 'object') return before
  try { await git(root, 'fetch', '-q', 'origin', 'main') }
  catch (e) { c.fetchError = String((e as { stderr?: string }).stderr || e).trim().split('\n')[0] }
  if (c.fetchError === undefined) {
    const [ahead, behind] = (await git(root, 'rev-list', '--left-right', '--count', 'HEAD...origin/main')).split(/\s+/).map(Number)
    Object.assign(c, { ahead, behind })
  }
  const step = nextStep(c)
  if (step !== 'pull') return step === 'fetch' ? 'current' : step   // 'fetch' cannot come back once fetched
  await git(root, 'merge', '-q', '--ff-only', 'origin/main')
  return 'pulled'
}

// The auto-update job writes the version it pulled from, and the next hub tells the owner. The mark goes only
// once the DM is sent (clearUpdatedFrom), so a failed DM is tried again at the next start. The oldest version
// wins when two pulls land before a restart.
export const markUpdatedFrom = (dir: string, from: string) => { try { writeFileSync(`${dir}/updated-from`, from, { flag: 'wx' }) } catch { /* an older mark stays */ } }
export const clearUpdatedFrom = (dir: string) => { try { unlinkSync(`${dir}/updated-from`) } catch { /* already gone */ } }
export function updatedNote(dir: string, root: string, now: string): string | undefined {
  let from: string
  try { from = readFileSync(`${dir}/updated-from`, 'utf8').trim() } catch { return }
  const [a, b] = [from.split(' ')[0]!, now.split(' ')[0]!]
  if (!from || a === b) { clearUpdatedFrom(dir); return }
  let origin = ''
  try { origin = gitNow(root, 'remote', 'get-url', 'origin') } catch { /* no origin: no link */ }
  const url = compareUrl(origin, a, b)
  return `Updated Kage from ${from} to ${now}.${url ? ` <${url}|What changed>` : ''}`
}
