// A release (ADR 0013): bump the version, tag vX.Y.Z, publish the notes, move `stable`. The decisions are
// core/release.ts and core/auto-update.ts; this file is the git and gh calls, async so the hub's socket never stalls.
import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { compareUrl, soakGate, soakSince } from '../core/auto-update.ts'
import { releasePlan } from '../core/release.ts'

const sh = async (root: string, cmd: string, ...args: string[]) =>
  (await promisify(execFile)(cmd, args, { cwd: root, encoding: 'utf8', timeout: 120_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })).stdout.trim()
const tryOut = async (root: string, cmd: string, ...args: string[]) => { try { return await sh(root, cmd, ...args) } catch { return undefined } }

// Only the repo's admin releases: an install with no push rights, or no gh login, never does.
export const isOwnerHub = async (root: string) => await tryOut(root, 'gh', 'repo', 'view', '--json', 'viewerPermission', '-q', '.viewerPermission') === 'ADMIN'

// True when main holds commits the `stable` tag lacks, and the tag (if any) sits on main's own history.
export async function mainAheadOfStable(root: string): Promise<boolean> {
  await sh(root, 'git', 'fetch', '-q', '--force', 'origin', 'main', 'refs/tags/stable:refs/tags/stable').catch(() => sh(root, 'git', 'fetch', '-q', 'origin', 'main'))
  if (await tryOut(root, 'git', 'rev-parse', '-q', '--verify', 'refs/tags/stable^{commit}') === undefined) return true
  if (await tryOut(root, 'git', 'merge-base', '--is-ancestor', 'refs/tags/stable', 'HEAD') === undefined) return false
  return await sh(root, 'git', 'rev-parse', 'HEAD') !== await sh(root, 'git', 'rev-parse', 'refs/tags/stable^{commit}')
}

// The three files that carry the version. Plugin installs update only when plugin.json's changes.
function writeVersion(root: string, version: string) {
  for (const f of ['package.json', 'package-lock.json', '.claude-plugin/plugin.json']) {
    const j = JSON.parse(readFileSync(join(root, f), 'utf8'))
    j.version = version
    if (j.packages?.['']) j.packages[''].version = version
    writeFileSync(join(root, f), JSON.stringify(j, null, 2) + '\n')
  }
}

export type Release = { version?: string; notes?: string; problems: string[]; url?: string }

// dryRun reads and checks only: it names every problem, prints the plan, and changes nothing anywhere.
export async function release(root: string, dryRun: boolean): Promise<Release> {
  const problems: string[] = []
  const branch = await sh(root, 'git', 'rev-parse', '--abbrev-ref', 'HEAD')
  if (branch !== 'main') problems.push(`on branch ${branch}, not main`)
  if (await sh(root, 'git', 'status', '--porcelain', '--untracked-files=no') !== '') problems.push('main has uncommitted changes')
  await sh(root, 'git', 'fetch', '-q', 'origin', 'main')
  await sh(root, 'git', 'fetch', '-q', '--force', 'origin', 'refs/tags/v*:refs/tags/v*').catch(() => {})   // no v tag yet is fine
  const head = await sh(root, 'git', 'rev-parse', 'HEAD')
  if (head !== await sh(root, 'git', 'rev-parse', 'origin/main')) problems.push('main is not the same commit as origin/main')
  const ci = await tryOut(root, 'gh', 'run', 'list', '--workflow', 'ci.yml', '--commit', head, '--limit', '1', '--json', 'status,conclusion', '-q', '.[0] | "\\(.status) \\(.conclusion)"')
  if (ci !== 'completed success') problems.push(`CI on ${head.slice(0, 7)} is not green (${ci ?? 'no run found'})`)

  const last = (await sh(root, 'git', 'tag', '--list', 'v*', '--sort=-v:refname')).split('\n')[0] || undefined
  // ponytail: with no earlier release the notes list the last 30 merges, not all history.
  const titles = (await sh(root, 'git', 'log', '--first-parent', '--format=%s', ...last ? [`${last}..HEAD`] : ['-30'])).split('\n').filter(Boolean)
  // A run that died after pushing its release commit left package.json bumped: finish that release, never bump twice.
  const pkg: string = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
  const resume = (await sh(root, 'git', 'log', '-1', '--format=%s')) === `Release v${pkg}` && await tryOut(root, 'git', 'rev-parse', '-q', '--verify', `refs/tags/v${pkg}`) === undefined
  const plan = releasePlan(pkg, titles)
  if (!plan) return { problems: [...problems, `nothing merged since ${last}`] }
  const version = resume ? pkg : plan.version
  const tag = `v${version}`
  if (await tryOut(root, 'git', 'rev-parse', '-q', '--verify', `refs/tags/${tag}`) !== undefined) problems.push(`the tag ${tag} already exists`)
  const origin = await tryOut(root, 'git', 'remote', 'get-url', 'origin') ?? ''
  const link = last ? compareUrl(origin, last, tag) : undefined
  const notes = plan.notes + (link ? `\n\nFull changes: ${link}` : '')
  if (dryRun || problems.length) return { version, notes, problems }

  // A failed push of main drops the release commit again. After it, a failed step is finished by the next run (resume above).
  if (!resume) {
    writeVersion(root, version)
    await sh(root, 'git', 'commit', '-q', '-m', `Release ${tag}`, '--', 'package.json', 'package-lock.json', '.claude-plugin/plugin.json')
    try { await sh(root, 'git', 'push', '-q', 'origin', 'main') }
    catch (e) {
      await sh(root, 'git', 'fetch', '-q', 'origin', 'main')   // a push that landed but timed out must not be dropped
      if (await sh(root, 'git', 'rev-parse', 'HEAD') !== await sh(root, 'git', 'rev-parse', 'origin/main')) await sh(root, 'git', 'reset', '-q', '--hard', 'HEAD~1')
      throw e
    }
  }
  await sh(root, 'git', 'tag', '-a', tag, '-m', tag)
  await sh(root, 'git', 'push', '-q', 'origin', `refs/tags/${tag}`)
  await sh(root, 'git', 'update-ref', 'refs/tags/stable', 'HEAD')   // a lightweight tag, whatever the user's git config says
  await sh(root, 'git', 'push', '-q', '-f', 'origin', 'refs/tags/stable')
  const file = join(mkdtempSync(join(tmpdir(), 'kage-release-')), 'notes.md')
  writeFileSync(file, notes)
  const url = await sh(root, 'gh', 'release', 'create', tag, '--verify-tag', '--title', tag, '--notes-file', file)
  return { version, notes, problems, url }
}

// The hub's daily check (router.ts): release when main is ahead of `stable` and the soak gate passes. A skip is
// one log line and no DM. Only the repo admin's hub gets past the first line.
export async function releaseIfSoaked(root: string, dir: string, running: string, boots: string, now: number): Promise<Release | { skip: string }> {
  if (!await isOwnerHub(root)) return { skip: 'this hub is not the repo admin' }
  if (!await mainAheadOfStable(root)) return { skip: 'main has nothing the stable tag lacks' }
  const num = (f: string) => { try { return readFileSync(join(dir, f), 'utf8').split('\n').map(Number).filter(Boolean) } catch { return [] } }
  const dm = Math.max(0, ...num('crash-dm-at')) * 1000 || undefined
  const gate = { candidate: await sh(root, 'git', 'rev-parse', 'HEAD'), running: running.split(' ')[0]!, since: soakSince(boots, running.split(' ')[0]!), crashDmAt: dm, now }
  // The doctor is the slow check, so it runs only once the cheap ones pass.
  let g = soakGate({ ...gate, doctorOk: true })
  if ('ok' in g) g = soakGate({ ...gate, doctorOk: (await tryOut(root, './setup.sh', 'doctor') ?? '').includes('All good') })
  if ('fail' in g) return { skip: g.fail }
  const r = await release(root, false)
  return r.problems.length ? { skip: r.problems.join('; ') } : r
}
