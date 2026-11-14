import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { frame, unframe } from '../../core/browser-pair.ts'

const HELPER = new URL('../browser-pair.ts', import.meta.url).pathname
const ask = (env: string) => {
  const dir = mkdtempSync(join(tmpdir(), 'kage-pair-'))
  writeFileSync(`${dir}/env`, env, { mode: 0o600 })
  return unframe(execFileSync(process.execPath, [HELPER], { input: frame({ want: 'token' }), env: { ...process.env, KAGE_ENV: `${dir}/env` } }))
}

test('the helper answers with the token and hub address from the settings file', () => {
  assert.deepEqual(ask('KAGE_NAME=kage\nKAGE_BROWSER_TOKEN=abc123\nKAGE_BROWSER_PORT=8800\n'), { token: 'abc123', hub: 'http://127.0.0.1:8800' })
  assert.deepEqual(ask('KAGE_BROWSER_TOKEN=abc123\n'), { token: 'abc123', hub: 'http://127.0.0.1:8791' })
})

test('with Kage in Chrome off, the helper says how to turn it on', () => {
  assert.deepEqual(ask('KAGE_NAME=kage\n'), { error: 'Kage in Chrome is off: run kage add browser' })
})
