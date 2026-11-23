import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CLI = new URL('../stats.ts', import.meta.url).pathname

test('kage stats before Kage ever started says so in one line, and creates no database', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kage-stats-'))
  for (const env of [`${dir}/env`, `${dir}/missing/env`]) {
    const { KAGE_THREAD: _, KAGE_SESSION: __, ...base } = process.env
    const r = spawnSync(process.execPath, [CLI], { encoding: 'utf8', env: { ...base, KAGE_ENV: env } })
    assert.equal(r.status, 1)
    assert.match(r.stderr, /^No \S+\/kage\.db yet: start Kage first\.$/m)
    assert.doesNotMatch(r.stderr, /at openLedgers/)
  }
  assert.equal(existsSync(`${dir}/kage.db`), false)
})
