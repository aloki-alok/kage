import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const runner = new URL('run.ts', import.meta.url).pathname

test('npm test kills a file that spins past the limit, names it, fails, and still runs the others', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kage-run-'))
  // A microtask spin never yields to timers, so only a parent can stop it (#277).
  writeFileSync(join(dir, 'spin.test.ts'), "import { test } from 'node:test'\ntest('spin', async () => { for (;;) await (async () => {})() })\n")
  writeFileSync(join(dir, 'ok.test.ts'), "import { test } from 'node:test'\ntest('ok', () => {})\n")
  const start = Date.now()
  const r = spawnSync(process.execPath, [runner, '--limit=2', `${dir}/*.test.ts`], { encoding: 'utf8', timeout: 30_000 })
  assert.ok(Date.now() - start < 15_000, 'the runner itself returned well before the outer timeout')
  assert.equal(r.status, 1)
  assert.match(r.stdout, /KILL .*spin\.test\.ts: still running after 2 s/)
  assert.match(r.stdout, /ok .*ok\.test\.ts/)
  assert.match(r.stdout, /1 files passed, 1 failed/)
})

test('a failing file prints its output and fails the run', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kage-run-'))
  writeFileSync(join(dir, 'bad.test.ts'), "import { test } from 'node:test'\ntest('bad', () => { throw new Error('boom-marker') })\n")
  const r = spawnSync(process.execPath, [runner, `${dir}/*.test.ts`], { encoding: 'utf8', timeout: 30_000 })
  assert.equal(r.status, 1)
  assert.match(r.stdout, /FAIL .*bad\.test\.ts/)
  assert.match(r.stdout, /boom-marker/)
})
