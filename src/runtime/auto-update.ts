import { execFile, execFileSync } from 'node:child_process'
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { compareUrl, nextStep, type Checkout } from '../core/auto-update.ts'

const git = async (root: string, ...args: string[]) =>
  (await promisify(execFile)('git', args, { cwd: root, encoding: 'utf8', timeout: 60_000 })).stdout.trim()
const gitNow = (root: string, ...args: string[]) =>
  execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const isCheckout = (root: string) => existsSync(join(root, '.git'))

export function version(root: string): string {
  if (!isCheckout(root)) return 'unknown (not a git checkout)'
  let release = ''
  try { release = `, v${(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string }).version}` } catch {  }
  try { const [sha, date] = gitNow(root, 'log', '-1', '--format=%h %cs').split(' '); return `${sha} (${date}${release})` }
  catch { return 'unknown (git log failed)' }
}

export async function pullMain(root: string): Promise<'pulled' | 'current' | { skip: string }> {
  const c: Checkout = { git: isCheckout(root) }
  if (c.git) {
    c.branch = await git(root, 'rev-parse', '--abbrev-ref', 'HEAD')
    c.dirty = await git(root, 'status', '--porcelain', '--untracked-files=no') !== ''
  }
  const before = nextStep(c)
  if (typeof before === 'object') return before
  try {
    c.stable = await git(root, 'ls-remote', '--tags', 'origin', 'refs/tags/stable') !== ''
    if (c.stable) await git(root, 'fetch', '-q', '--force', '--no-tags', 'origin', 'refs/tags/stable:refs/tags/stable')
  } catch (e) { c.fetchError = String((e as { stderr?: string }).stderr || e).trim().split('\n')[0] }
  if (c.fetchError === undefined && c.stable) {
    const [ahead, behind] = (await git(root, 'rev-list', '--left-right', '--count', 'HEAD...refs/tags/stable^{commit}')).split(/\s+/).map(Number)
    Object.assign(c, { ahead, behind })
  }
  const step = nextStep(c)
  if (step !== 'pull') return step === 'fetch' ? 'current' : step
  await git(root, 'merge', '-q', '--ff-only', 'refs/tags/stable^{commit}')
  return 'pulled'
}

export const markUpdatedFrom = (dir: string, from: string) => { try { writeFileSync(`${dir}/updated-from`, from, { flag: 'wx' }) } catch {  } }
export const clearUpdatedFrom = (dir: string) => { try { unlinkSync(`${dir}/updated-from`) } catch {  } }
export function updatedNote(dir: string, root: string, now: string): string | undefined {
  let from: string
  try { from = readFileSync(`${dir}/updated-from`, 'utf8').trim() } catch { return }
  const [a, b] = [from.split(' ')[0]!, now.split(' ')[0]!]
  if (!from || a === b) { clearUpdatedFrom(dir); return }
  let origin = ''
  try { origin = gitNow(root, 'remote', 'get-url', 'origin') } catch {  }
  const url = compareUrl(origin, a, b)
  return `Updated Kage from ${from} to ${now}.${url ? ` <${url}|What changed>` : ''}`
}
