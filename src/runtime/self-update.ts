import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'

export type Updated = { current: true } | { moved: { old: string; new: string; packages: boolean; subjects: string[] } } | { refused: string }

const git = async (root: string, ...args: string[]) => (await promisify(execFile)('git', args, { cwd: root, encoding: 'utf8', timeout: 60_000 })).stdout.trim()
const reason = (e: unknown) => String((e as { stderr?: string }).stderr || e).trim().split('\n')[0]!

let last: Promise<unknown> = Promise.resolve()

export function fastForward(root: string, stable: boolean): Promise<Updated> {
  const next = last.then(() => move(root, stable)).catch(e => ({ refused: `git failed: ${reason(e)}` }))
  last = next
  return next
}

async function move(root: string, stable: boolean): Promise<Updated> {
  if (!existsSync(join(root, '.git'))) return { refused: 'this install is not a git checkout, so run the install line again to update it' }
  const changed = await git(root, 'status', '--porcelain', '--untracked-files=no')
  if (changed) return { refused: `this checkout has local changes, so it was left as it is: ${changed.split('\n').map(l => l.trim().split(/\s+/).pop()).join(' ')}` }
  await git(root, 'fetch', '-q', '--force', 'origin', 'main', '--tags')
  const ref = stable ? 'refs/tags/stable^{commit}' : 'origin/main'
  const target = await git(root, 'rev-parse', '--verify', '-q', ref).catch(() => '')
  if (!target) return { refused: 'origin has no stable release yet' }
  if (await git(root, 'rev-list', '--count', `${target}..HEAD`) !== '0') return { refused: `this checkout has commits that are not on ${stable ? 'stable' : 'origin/main'}, so it was left as it is` }
  const old = await git(root, 'rev-parse', '--short', 'HEAD')
  if (await git(root, 'rev-parse', 'HEAD') === target) return { current: true }
  const packages = await git(root, 'diff', '--name-only', 'HEAD', target, '--', 'package-lock.json') !== ''
  await git(root, 'merge', '-q', '--ff-only', target)
  const subjects = (await git(root, 'log', '--format=%s', `${old}..HEAD`)).split('\n').filter(Boolean)
  return { moved: { old, new: await git(root, 'rev-parse', '--short', 'HEAD'), packages, subjects } }
}
