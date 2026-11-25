import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fastForward } from '../self-update.ts'

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.test', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const commit = (cwd: string, file: string, message = file) => {
  writeFileSync(join(cwd, file), file)
  git(cwd, 'add', file)
  git(cwd, 'commit', '-qm', message)
}
function repos() {
  const root = mkdtempSync(join(tmpdir(), 'kage-self-update-'))
  const origin = join(root, 'origin'), local = join(root, 'local')
  git(root, 'init', '-q', '-b', 'main', origin)
  commit(origin, 'a.ts')
  git(root, 'clone', '-q', origin, local)
  return { origin, local }
}

test('a clean checkout moves to origin main and reports the old and new commit, the new subjects and whether packages changed', async () => {
  const { origin, local } = repos()
  const before = git(local, 'rev-parse', '--short', 'HEAD')
  commit(origin, 'b.ts', 'feat(cli): a new thing (#1)')
  commit(origin, 'package-lock.json', 'fix(core): a fixed thing')
  const r = await fastForward(local, false)
  assert.deepEqual(r, { moved: { old: before, new: git(origin, 'rev-parse', '--short', 'HEAD'), packages: true, subjects: ['fix(core): a fixed thing', 'feat(cli): a new thing (#1)'] } })
  assert.equal(git(local, 'rev-parse', 'HEAD'), git(origin, 'rev-parse', 'HEAD'))
})

test('a checkout already on origin main says it is current', async () => {
  const { local } = repos()
  assert.deepEqual(await fastForward(local, false), { current: true })
})

test('local changes to tracked files refuse the update and leave the checkout as it is', async () => {
  const { origin, local } = repos()
  commit(origin, 'b.ts')
  writeFileSync(join(local, 'a.ts'), 'edited')
  const head = git(local, 'rev-parse', 'HEAD')
  const r = await fastForward(local, false)
  assert.match((r as { refused: string }).refused, /local changes.*a\.ts/)
  assert.equal(git(local, 'rev-parse', 'HEAD'), head)
})

test('a local commit that is not on origin refuses the update', async () => {
  const { origin, local } = repos()
  commit(origin, 'b.ts')
  commit(local, 'mine.ts')
  const head = git(local, 'rev-parse', 'HEAD')
  const r = await fastForward(local, false)
  assert.match((r as { refused: string }).refused, /commits that are not on/)
  assert.equal(git(local, 'rev-parse', 'HEAD'), head)
})

test('stable moves to the stable tag, not past it', async () => {
  const { origin, local } = repos()
  commit(origin, 'b.ts')
  git(origin, 'tag', '-a', '-m', 'stable', 'stable')
  const tagged = git(origin, 'rev-parse', 'HEAD')
  commit(origin, 'c.ts')
  const r = await fastForward(local, true)
  assert.ok('moved' in r)
  assert.equal(git(local, 'rev-parse', 'HEAD'), tagged)
})

test('a second update asked while one runs does its own move after it, for the ref it asked for', async () => {
  const { origin, local } = repos()
  commit(origin, 'b.ts')
  git(origin, 'tag', '-a', '-m', 'stable', 'stable')
  const tagged = git(origin, 'rev-parse', '--short', 'HEAD')
  commit(origin, 'c.ts')
  const [toStable, toMain] = await Promise.all([fastForward(local, true), fastForward(local, false)])
  assert.ok('moved' in toStable && toStable.moved.new === tagged)
  assert.ok('moved' in toMain && toMain.moved.old === tagged)
  assert.equal(git(local, 'rev-parse', 'HEAD'), git(origin, 'rev-parse', 'HEAD'))
})

test('stable with no stable tag refuses', async () => {
  const { origin, local } = repos()
  commit(origin, 'b.ts')
  assert.match(((await fastForward(local, true)) as { refused: string }).refused, /stable/)
})

test('a folder that is not a git checkout refuses', async () => {
  const r = await fastForward(mkdtempSync(join(tmpdir(), 'kage-nogit-')), false)
  assert.match((r as { refused: string }).refused, /not a git checkout/)
})
