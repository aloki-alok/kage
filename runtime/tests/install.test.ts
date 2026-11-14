// The install line, run for real against a local origin and tarball, in a temp HOME. Nothing here reaches GitHub.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pullMain } from '../auto-update.ts'

const REPO = join(import.meta.dirname, '../..')
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const commit = (cwd: string, file: string, text: string) => {
  writeFileSync(join(cwd, file), text)
  git(cwd, 'add', '-A')
  git(cwd, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', file)
}

function world() {
  const root = mkdtempSync(join(tmpdir(), 'kage-install-'))
  const home = join(root, 'home'), bin = join(root, 'bin'), origin = join(root, 'origin'), dir = join(home, 'kage-code')
  for (const d of [home, bin, origin, join(home, '.config/kage')]) mkdirSync(d, { recursive: true })
  // A fake claude, so the tool check passes where Claude Code is not installed (CI).
  writeFileSync(join(bin, 'claude'), '#!/bin/sh\necho 1.0.0\n'); chmodSync(join(bin, 'claude'), 0o755)
  // An existing env file: the script updates and does not start the setup.
  writeFileSync(join(home, '.config/kage/env'), 'KAGE_NAME=kage\n')
  git(root, 'init', '-q', '-b', 'main', origin)
  // No dependencies, so npm ci runs offline in a moment.
  writeFileSync(join(origin, 'package.json'), '{"name":"fake","version":"1.0.0"}\n')
  writeFileSync(join(origin, 'package-lock.json'), '{"name":"fake","version":"1.0.0","lockfileVersion":3,"requires":true,"packages":{"":{"name":"fake","version":"1.0.0"}}}\n')
  writeFileSync(join(origin, '.gitignore'), 'node_modules\n')
  writeFileSync(join(origin, 'setup.sh'), '#!/bin/sh\n'); chmodSync(join(origin, 'setup.sh'), 0o755)
  commit(origin, 'a.ts', 'v1')
  // The same code as GitHub's tarball shapes it: one top folder.
  execFileSync('git', ['archive', '--format=tar.gz', '--prefix=kage-main/', '-o', join(root, 'main.tar.gz'), 'main'], { cwd: origin })
  const install = (env: Record<string, string> = {}) => execFileSync('/bin/bash', [join(REPO, 'install.sh')], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      PATH: `${bin}:${dirname(process.execPath)}:${process.env.PATH}`, HOME: home, KAGE_DIR: dir, KAGE_BIN: bin, KAGE_GIT_URL: origin,
      // A person whose git rebases on pull, with an identity: only --ff-only keeps their own commit from being moved.
      GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com',
      GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'pull.rebase', GIT_CONFIG_VALUE_0: 'true', ...env,
    },
  })
  return { root, origin, dir, home, install }
}

test('a tarball install run again with git becomes a clean main checkout in place, which then updates itself', async () => {
  const w = world()
  w.install({ KAGE_TARBALL: join(w.root, 'main.tar.gz') })
  assert.equal(existsSync(join(w.dir, '.git')), false)
  mkdirSync(join(w.dir, 'node_modules')); writeFileSync(join(w.dir, 'node_modules', 'kept'), '')   // stands in for installed packages
  const env = readFileSync(join(w.home, '.config/kage/env'), 'utf8')

  commit(w.origin, 'b.ts', 'v2')
  w.install()
  assert.equal(git(w.dir, 'rev-parse', 'HEAD'), git(w.origin, 'rev-parse', 'HEAD'))
  assert.equal(git(w.dir, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main')
  assert.equal(git(w.dir, 'status', '--porcelain', '--untracked-files=no'), '')
  assert.equal(readFileSync(join(w.dir, 'b.ts'), 'utf8'), 'v2')
  assert.equal(readFileSync(join(w.home, '.config/kage/env'), 'utf8'), env)
  assert.deepEqual(readdirSync(w.dir).filter(f => f.startsWith('.kage-clone')), [])   // no clone left behind

  // The hub's own job then pulls the next commit, once the owner tags it stable.
  commit(w.origin, 'c.ts', 'v3')
  git(w.origin, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'tag', '-f', '-a', '-m', 'stable', 'stable')
  assert.equal(await pullMain(w.dir), 'pulled')
  assert.equal(readFileSync(join(w.dir, 'c.ts'), 'utf8'), 'v3')
})

test('run again on a checkout, it fast-forwards; a checkout with its own edits is left alone', () => {
  const w = world()
  w.install()
  commit(w.origin, 'b.ts', 'v2')
  w.install()
  assert.equal(git(w.dir, 'rev-parse', 'HEAD'), git(w.origin, 'rev-parse', 'HEAD'))
  commit(w.dir, 'mine.ts', 'local work')
  commit(w.origin, 'c.ts', 'v3')
  assert.throws(() => w.install(), /changes of its own/)
  assert.equal(readFileSync(join(w.dir, 'mine.ts'), 'utf8'), 'local work')
  assert.equal(git(w.dir, 'log', '-1', '--format=%s'), 'mine.ts')
})
