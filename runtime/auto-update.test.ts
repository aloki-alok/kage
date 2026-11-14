import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { clearUpdatedFrom, markUpdatedFrom, pullMain, updatedNote, version } from './auto-update.ts'

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const commit = (cwd: string, file: string) => {
  writeFileSync(join(cwd, file), file)
  git(cwd, 'add', file)
  git(cwd, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', file)
}
// The owner moves the stable tag by hand: forced, annotated like a release would be.
const stable = (origin: string, at = 'HEAD') => git(origin, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'tag', '-f', '-a', '-m', 'stable', 'stable', at)
// An origin with one commit on main, tagged stable, and a checkout of it.
function repos() {
  const root = mkdtempSync(join(tmpdir(), 'kage-update-'))
  const origin = join(root, 'origin'), local = join(root, 'local')
  git(root, 'init', '-q', '-b', 'main', origin)
  commit(origin, 'a.ts')
  stable(origin)
  git(root, 'clone', '-q', origin, local)
  return { origin, local }
}

test('a clean main fast-forwards to the stable tag, never past it to origin/main', async () => {
  const { origin, local } = repos()
  commit(origin, 'b.ts')
  stable(origin)
  const tagged = git(origin, 'rev-parse', 'HEAD')
  commit(origin, 'c.ts')
  assert.equal(await pullMain(local), 'pulled')
  assert.equal(git(local, 'rev-parse', 'HEAD'), tagged)
  assert.equal(await pullMain(local), 'current')
  // The owner moves the tag on, as the documented push does (a lightweight tag): the next run follows it.
  git(origin, 'tag', '-d', 'stable')
  git(origin, 'update-ref', 'refs/tags/stable', 'HEAD')
  assert.equal(await pullMain(local), 'pulled')
  assert.equal(git(local, 'rev-parse', 'HEAD'), git(origin, 'rev-parse', 'HEAD'))
})

test('with no stable tag on origin, nothing is pulled', async () => {
  const { origin, local } = repos()
  git(origin, 'tag', '-d', 'stable')
  commit(origin, 'b.ts')
  const before = git(local, 'rev-parse', 'HEAD')
  assert.deepEqual(await pullMain(local), { skip: 'origin has no stable tag yet' })
  assert.equal(git(local, 'rev-parse', 'HEAD'), before)
})

test('a stable tag moved back, behind main, is never followed', async () => {
  const { origin, local } = repos()
  const first = git(origin, 'rev-parse', 'HEAD')
  commit(origin, 'b.ts')
  stable(origin)
  assert.equal(await pullMain(local), 'pulled')
  stable(origin, first)
  const before = git(local, 'rev-parse', 'HEAD')
  assert.deepEqual(await pullMain(local), { skip: 'main has 1 commit that the stable tag lacks' })
  assert.equal(git(local, 'rev-parse', 'HEAD'), before)
})

test('a checkout with uncommitted changes is left as it is', async () => {
  const { origin, local } = repos()
  commit(origin, 'b.ts')
  stable(origin)
  const before = git(local, 'rev-parse', 'HEAD')
  writeFileSync(join(local, 'a.ts'), 'my edit')
  assert.deepEqual(await pullMain(local), { skip: 'the checkout has uncommitted changes' })
  assert.equal(git(local, 'rev-parse', 'HEAD'), before)
})

test('a local commit on main is never pulled over', async () => {
  const { origin, local } = repos()
  commit(origin, 'b.ts')
  stable(origin)
  commit(local, 'mine.ts')
  const before = git(local, 'rev-parse', 'HEAD')
  assert.deepEqual(await pullMain(local), { skip: 'main has 1 commit that the stable tag lacks' })
  assert.equal(git(local, 'rev-parse', 'HEAD'), before)
})

test('main and origin that both moved on are left as they are', async () => {
  const { origin, local } = repos()
  commit(origin, 'b.ts')
  commit(local, 'mine.ts')
  commit(local, 'mine2.ts')
  stable(origin)
  assert.deepEqual(await pullMain(local), { skip: 'main has 2 commits that the stable tag lacks' })
})

test('another branch, or an origin that cannot be reached, does nothing', async () => {
  const { origin, local } = repos()
  commit(origin, 'b.ts')
  git(local, 'checkout', '-qb', 'my-fix')
  assert.deepEqual(await pullMain(local), { skip: 'on branch my-fix, not main' })
  git(local, 'checkout', '-q', 'main')
  git(local, 'remote', 'set-url', 'origin', join(origin, 'gone'))
  const r = await pullMain(local)
  assert.ok(typeof r === 'object' && r.skip.startsWith('could not reach origin: '), JSON.stringify(r))
})

test('a folder with no .git of its own is not a checkout, even inside one', async () => {
  const { local } = repos()
  const inner = join(local, 'sub')
  execFileSync('mkdir', [inner])
  assert.deepEqual(await pullMain(inner), { skip: 'not a git checkout' })
})

test('the version is the short sha and the commit date', () => {
  const { local } = repos()
  assert.match(version(local), /^[0-9a-f]{7,} \(\d{4}-\d{2}-\d{2}\)$/)
  assert.equal(version(join(local, 'nope')), 'unknown (not a git checkout)')
})

test('the hub after an update tells the owner once, with the compare link', () => {
  const { local } = repos()
  const dir = mkdtempSync(join(tmpdir(), 'kage-dir-'))
  git(local, 'remote', 'set-url', 'origin', 'https://github.com/acme/kage.git')
  markUpdatedFrom(dir, 'aaa1111 (2026-01-01)')
  markUpdatedFrom(dir, 'bbb2222 (2026-01-02)')   // a second pull before the restart keeps the first version
  assert.equal(updatedNote(dir, local, 'ccc3333 (2026-01-03)'),
    'Updated Kage from aaa1111 (2026-01-01) to ccc3333 (2026-01-03). <https://github.com/acme/kage/compare/aaa1111...ccc3333|What changed>')
  // Not sent yet: the next start tries again. Sent: never again.
  assert.match(updatedNote(dir, local, 'ccc3333 (2026-01-03)') ?? '', /^Updated Kage from aaa1111/)
  clearUpdatedFrom(dir)
  assert.equal(updatedNote(dir, local, 'ccc3333 (2026-01-03)'), undefined)
})

test('a restart on the same version says nothing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kage-dir-'))
  markUpdatedFrom(dir, 'aaa1111 (2026-01-01)')
  assert.equal(updatedNote(dir, dir, 'aaa1111 (2026-01-01)'), undefined)
})
