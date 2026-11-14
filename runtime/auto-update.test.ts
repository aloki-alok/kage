import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { markUpdatedFrom, pullMain, updatedNote, version } from './auto-update.ts'

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const commit = (cwd: string, file: string) => {
  writeFileSync(join(cwd, file), file)
  git(cwd, 'add', file)
  git(cwd, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', file)
}
// An origin with one commit on main, and a checkout of it.
function repos() {
  const root = mkdtempSync(join(tmpdir(), 'kage-update-'))
  const origin = join(root, 'origin'), local = join(root, 'local')
  git(root, 'init', '-q', '-b', 'main', origin)
  commit(origin, 'a.ts')
  git(root, 'clone', '-q', origin, local)
  return { origin, local }
}

test('a clean main behind origin fast-forwards to it', async () => {
  const { origin, local } = repos()
  commit(origin, 'b.ts')
  const r = await pullMain(local)
  assert.equal(r, 'pulled')
  assert.equal(git(local, 'rev-parse', 'HEAD'), git(origin, 'rev-parse', 'HEAD'))
})

test('a checkout with uncommitted changes is left as it is', async () => {
  const { origin, local } = repos()
  commit(origin, 'b.ts')
  const before = git(local, 'rev-parse', 'HEAD')
  writeFileSync(join(local, 'a.ts'), 'my edit')
  assert.deepEqual(await pullMain(local), { skip: 'the checkout has uncommitted changes' })
  assert.equal(git(local, 'rev-parse', 'HEAD'), before)
})

test('a local commit on main is never pulled over', async () => {
  const { origin, local } = repos()
  commit(origin, 'b.ts')
  commit(local, 'mine.ts')
  const before = git(local, 'rev-parse', 'HEAD')
  assert.deepEqual(await pullMain(local), { skip: 'main has 1 local commit that origin/main lacks' })
  assert.equal(git(local, 'rev-parse', 'HEAD'), before)
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
  assert.equal(updatedNote(dir, local, 'ccc3333 (2026-01-03)'), undefined)
})

test('a restart on the same version says nothing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kage-dir-'))
  markUpdatedFrom(dir, 'aaa1111 (2026-01-01)')
  assert.equal(updatedNote(dir, dir, 'aaa1111 (2026-01-01)'), undefined)
})
