import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { compareUrl, inertChange, soakGate, type Boot, type ErrorSeen } from '../core/auto-update.ts'
import { checkProblems, RELEASE_CHECKS, releasePlan } from '../core/release.ts'

const sh = async (root: string, cmd: string, ...args: string[]) =>
  (await promisify(execFile)(cmd, args, { cwd: root, encoding: 'utf8', timeout: 120_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })).stdout.trim()
const tryOut = async (root: string, cmd: string, ...args: string[]) => { try { return await sh(root, cmd, ...args) } catch { return undefined } }

const isOwnerHub = async (root: string) => await tryOut(root, 'gh', 'repo', 'view', '--json', 'viewerPermission', '-q', '.viewerPermission') === 'ADMIN'

async function aheadOfStable(root: string, sha: string): Promise<boolean> {
  if (!await tryOut(root, 'git', 'rev-parse', '-q', '--verify', 'refs/tags/stable^{commit}')) return true
  if (await tryOut(root, 'git', 'merge-base', '--is-ancestor', 'refs/tags/stable', sha) === undefined) return false
  return !await inert(root, 'refs/tags/stable', sha)
}
const fetchRefs = (root: string) =>
  sh(root, 'git', 'fetch', '-q', '--force', 'origin', 'main', 'refs/tags/stable:refs/tags/stable').catch(() => sh(root, 'git', 'fetch', '-q', 'origin', 'main'))

function writeVersion(root: string, version: string) {
  for (const f of ['package.json', '.claude-plugin/plugin.json']) {
    const j = JSON.parse(readFileSync(join(root, f), 'utf8'))
    j.version = version
    if (j.packages?.['']) j.packages[''].version = version
    writeFileSync(join(root, f), JSON.stringify(j, null, 2) + '\n')
  }
}

export type Release = { version?: string; notes?: string; problems: string[]; url?: string }

export async function release(root: string, dryRun: boolean, at = 'HEAD'): Promise<Release> {
  const problems: string[] = []
  const branch = await sh(root, 'git', 'rev-parse', '--abbrev-ref', 'HEAD')
  if (branch !== 'main') problems.push(`on branch ${branch}, not main`)
  if (await sh(root, 'git', 'status', '--porcelain', '--untracked-files=no') !== '') problems.push('main has uncommitted changes')
  await sh(root, 'git', 'fetch', '-q', 'origin', 'main')
  await sh(root, 'git', 'fetch', '-q', '--force', 'origin', 'refs/tags/v*:refs/tags/v*').catch(() => {})
  if (await sh(root, 'git', 'rev-parse', 'HEAD') !== await sh(root, 'git', 'rev-parse', 'origin/main')) problems.push('main is not the same commit as origin/main')
  const sha = await sh(root, 'git', 'rev-parse', `${at}^{commit}`)
  if (await tryOut(root, 'git', 'merge-base', '--is-ancestor', sha, 'origin/main') === undefined) problems.push(`${sha.slice(0, 7)} is not on main`)
  const runs = Object.fromEntries(await Promise.all(RELEASE_CHECKS.map(async w => [w, await tryOut(root, 'gh', 'run', 'list', '--workflow', w, '--commit', sha, '--limit', '1', '--json', 'status,conclusion', '-q', '.[0] | "\\(.status) \\(.conclusion)"') || undefined])))
  problems.push(...checkProblems(sha, runs))

  const last = (await sh(root, 'git', 'tag', '--list', 'v*', '--sort=-v:refname')).split('\n')[0] || undefined
  const titles = (await sh(root, 'git', 'log', '--first-parent', '--format=%s', ...last ? [`${last}..${sha}`] : ['-30', sha])).split('\n').filter(Boolean)
  const plan = releasePlan(JSON.parse(await sh(root, 'git', 'show', `${sha}:package.json`)).version, titles)
  if (!plan) return { problems: [...problems, `nothing merged since ${last}`] }
  const { version } = plan
  const tag = `v${version}`
  if (await tryOut(root, 'git', 'rev-parse', '-q', '--verify', `refs/tags/${tag}`) !== undefined) problems.push(`the tag ${tag} already exists`)
  const origin = await tryOut(root, 'git', 'remote', 'get-url', 'origin') ?? ''
  const link = last ? compareUrl(origin, last, tag) : undefined
  const notes = plan.notes + (link ? `\n\nFull changes: ${link}` : '')
  if (dryRun || problems.length) return { version, notes, problems }

  const tmp = mkdtempSync(join(tmpdir(), 'kage-release-'))
  const wt = join(tmp, 'wt')
  await sh(root, 'git', 'worktree', 'add', '-q', '--detach', wt, sha)
  try {
    writeVersion(wt, version)
    await sh(wt, 'git', 'commit', '-q', '-m', `Release ${tag}`, '--', 'package.json', '.claude-plugin/plugin.json')
    const rel = await sh(wt, 'git', 'rev-parse', 'HEAD')
    await sh(root, 'git', 'tag', '-a', tag, '-m', tag, rel)
    try {
      await sh(root, 'git', 'merge', '-q', '-m', `Release ${tag}: its version bump, made on the soaked commit`, rel)
      await sh(root, 'git', 'push', '-q', '--atomic', 'origin', 'main', `refs/tags/${tag}`, `+${rel}:refs/tags/stable`)
    } catch (e) {
      if (!await tryOut(root, 'git', 'ls-remote', '--tags', 'origin', `refs/tags/${tag}`)) {
        await tryOut(root, 'git', 'merge', '--abort')
        await sh(root, 'git', 'reset', '-q', '--hard', 'origin/main')
        await sh(root, 'git', 'tag', '-d', tag)
        throw e
      }
    }
    await sh(root, 'git', 'update-ref', 'refs/tags/stable', rel)
    const file = join(tmp, 'notes.md')
    writeFileSync(file, notes)
    const url = await sh(root, 'gh', 'release', 'create', tag, '--verify-tag', '--title', tag, '--notes-file', file)
      .catch(e => { throw new Error(`${tag} is on origin and stable moved, but its GitHub Release failed (${e}). Make it with: gh release create ${tag} --verify-tag --generate-notes`) })
    return { version, notes, problems, url }
  } finally { await tryOut(root, 'git', 'worktree', 'remove', '--force', wt) }
}

async function inert(root: string, from: string, to: string): Promise<boolean> {
  try {
    const names = (await sh(root, 'git', 'diff', '--name-only', from, to)).split('\n').filter(Boolean)
    const versionOnly = async (path: string) => {
      const strip = async (c: string) => { const j = JSON.parse(await sh(root, 'git', 'show', `${c}:${path}`)); delete j.version; if (j.packages?.['']) delete j.packages[''].version; return JSON.stringify(j) }
      try { return await strip(from) === await strip(to) } catch { return false }
    }
    return inertChange(await Promise.all(names.map(async path => ({ path, versionOnly: /\.json$/.test(path) ? await versionOnly(path) : undefined }))))
  } catch { return false }
}

async function readBoots(root: string, text: string, now: number): Promise<Boot[]> {
  const rows = text.split('\n').filter(Boolean).map(l => { const [at = '', sha = ''] = l.split('\t'); return { at: Date.parse(at), sha } })
    .filter(r => r.sha && r.at > now - 30 * 86_400_000)
  const boots: Boot[] = []
  for (const [i, r] of rows.entries()) {
    const prev = rows[i - 1]
    const changed = prev && !(prev.sha.startsWith(r.sha) || r.sha.startsWith(prev.sha))
    boots.push({ ...r, inert: changed ? await inert(root, prev.sha, r.sha) : false })
  }
  return boots
}

export async function releaseIfSoaked(root: string, dir: string, boots: string, now: number, errors: ErrorSeen[]): Promise<Release | { skip: string; candidate?: true; held?: { sha: string } }> {
  if (!await isOwnerHub(root)) return { skip: 'this hub is not the repo admin' }
  await fetchRefs(root)
  const rows = await readBoots(root, boots, now)
  const shas = [...new Set(rows.map(b => b.sha))]
  const ahead = new Set<string>()
  for (const sha of shas) if (await tryOut(root, 'git', 'rev-parse', '-q', '--verify', `${sha}^{commit}`) && await aheadOfStable(root, sha)) ahead.add(sha)
  let crashDm: number[] = []
  try { crashDm = readFileSync(join(dir, 'crash-dm-at'), 'utf8').split('\n').map(Number).filter(Boolean).map(t => t * 1000) } catch {  }
  const gate = { boots: rows, crashes: crashDm, now, ahead: (sha: string) => ahead.has(sha), errors }
  let g = soakGate({ ...gate, doctorOk: true })
  if ('ok' in g) g = soakGate({ ...gate, doctorOk: (await tryOut(root, './setup.sh', 'doctor') ?? '').includes('All good') })
  if ('fail' in g) return { skip: g.fail, candidate: g.sha ? true : undefined, ...g.held && g.sha && { held: { sha: g.sha } } }
  const r = await release(root, false, g.sha)
  const stillRunning = r.problems.every(p => /\((in_progress|queued|waiting|pending|requested) \)$/.test(p))
  return r.problems.length ? { skip: r.problems.join('; '), ...!stillRunning && { held: { sha: g.sha } } } : r
}
