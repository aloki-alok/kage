import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname
// Claude Code runs a hook command through the shell, so the test does too.
const command: string = JSON.parse(readFileSync(join(ROOT, 'hooks/hooks.json'), 'utf8')).hooks.PreToolUse[0].hooks[0].command
const run = (pluginRoot: string, input: string, env: Record<string, string> = {}) =>
  spawnSync('sh', ['-c', command], { input, encoding: 'utf8', env: { PATH: process.env.PATH!, CLAUDE_PLUGIN_ROOT: pluginRoot, KAGE_ENV: join(tmpdir(), 'kage-no-such-env'), ...env } })
const call = (tool_name: string) => JSON.stringify({ tool_name, tool_input: {} })

test('a missing guard script blocks the call with exit 2 and a restart hint', () => {
  const r = run(mkdtempSync(join(tmpdir(), 'kage-hook-')), call('Write'))
  assert.equal(r.status, 2)
  assert.match(r.stderr, /restart the Claude Code session/i)
})
test('a guard that crashes on bad input blocks with exit 2 and a restart hint', () => {
  const r = run(ROOT, 'not json', { KAGE_THREAD: 't1', HOME: tmpdir() })
  assert.equal(r.status, 2)
  assert.match(r.stderr, /restart the Claude Code session/i)
})
test('a real allow exits 0 with no output', () => {
  const r = run(ROOT, call('Write'))
  assert.equal(r.status, 0)
  assert.equal(r.stdout, '')
})
test('a real block still prints the deny decision and exits 0', () => {
  const r = run(ROOT, call('mcp__gmail__read'), { KAGE_THREAD: 't1', HOME: tmpdir() })
  assert.equal(r.status, 0)
  assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, 'deny')
})
