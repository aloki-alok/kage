// Why this install would not update itself (the rules are core/auto-update.ts).
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
    n = autoUpdateNote({ ...f, origin: r.status !== 0 ? 'failed' : r.stdout.trim() === '' ? 'no-stable' : 'stable' })
  }
  return n && n !== 'ask-origin' ? [n] : []
}
