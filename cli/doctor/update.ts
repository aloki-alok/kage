import { existsSync } from 'node:fs'
import { autoUpdateNote } from '../../core/doctor.ts'
import { config, ROOT, sh, type Group } from './context.ts'

const git = (...a: string[]) => sh('git', a).stdout.trim()

export const update: Group = () => {
  const isGit = existsSync(`${ROOT}/.git`)
  const f = { off: config.autoUpdate === false, git: isGit, branch: isGit ? git('rev-parse', '--abbrev-ref', 'HEAD') : undefined, dirty: isGit && git('status', '--porcelain', '--untracked-files=no') !== '' }
  let n = autoUpdateNote(f)
  if (n === 'ask-origin') {
    const r = sh('git', ['ls-remote', '--tags', 'origin', 'refs/tags/stable'], 30_000)
    const sha = r.stdout.trim().split(/\s/)[0] ?? ''
    const ancestor = (a: string, b: string) => sh('git', ['merge-base', '--is-ancestor', a, b]).status === 0
    const known = sha !== '' && sh('git', ['cat-file', '-e', `${sha}^{commit}`]).status === 0
    const diverged = known && !ancestor(sha, 'HEAD') && !ancestor('HEAD', sha)
    n = autoUpdateNote({ ...f, origin: r.status !== 0 ? 'failed' : sha === '' ? 'no-stable' : diverged ? 'diverged' : 'stable' })
  }
  return n && n !== 'ask-origin' ? [n] : []
}
