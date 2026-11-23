import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOOK = new URL('../private-data-guard.ts', import.meta.url).pathname
const conf = realpathSync(mkdtempSync(join(tmpdir(), 'kage-hook-')))
const run = (tool_name: string, tool_input: Record<string, string>, thread = 'C1:1.2') =>
  execFileSync(process.execPath, [HOOK], { input: JSON.stringify({ tool_name, tool_input }), env: { PATH: process.env.PATH!, HOME: conf, KAGE_ENV: join(conf, 'env'), KAGE_THREAD: thread }, encoding: 'utf8' })
const denied = (out: string) => out.includes('"permissionDecision":"deny"')

test('the tmux hook runs for every tool, so file reads and the shell reach the same checks as an SDK session', () => {
  const { hooks } = JSON.parse(readFileSync(new URL('../../hooks/hooks.json', import.meta.url), 'utf8'))
  const matcher = new RegExp(`^(?:${hooks.PreToolUse[0].matcher === '*' ? '.*' : hooks.PreToolUse[0].matcher})$`)
  for (const t of ['Read', 'Grep', 'Glob', 'Bash', 'Write', 'mcp__any__tool']) assert.ok(matcher.test(t), t)
})

test('with no sender file the hook still checks, as for a teammate: the token file stays closed', () => {
  assert.ok(denied(run('Read', { file_path: join(conf, 'secrets.json') })))
  assert.ok(denied(run('mcp__claude_ai_Gmail__search', {})))
  assert.ok(denied(run('mcp__new_crm__read_deals', {})), 'an MCP server nobody shared')
})

test("the hook reads the sender file: config.json is closed to others and open to the owner's own pane", () => {
  assert.ok(denied(run('Read', { file_path: join(conf, 'config.json') })))
  mkdirSync(join(conf, 'sender'), { recursive: true })
  writeFileSync(join(conf, 'sender', 'C1_1.2'), 'owner')
  assert.equal(run('Read', { file_path: join(conf, 'config.json') }), '')
})

test("the owner's pane may edit an existing note in the owner's memory, and a side lane on the owner's task may not (#564)", () => {
  const mem = join(conf, '.claude/projects', conf.replace(/[^A-Za-z0-9]/g, '-'), 'memory')
  mkdirSync(mem, { recursive: true })
  writeFileSync(join(mem, 'style.md'), 'x')
  mkdirSync(join(conf, 'sender'), { recursive: true })
  writeFileSync(join(conf, 'sender', 'C1_1.2'), 'owner')
  writeFileSync(join(conf, 'sender', 'C1_1.2_side_dream'), 'owner')
  const edit = { file_path: join(mem, 'style.md'), old_string: 'x', new_string: 'y' }
  assert.equal(run('Edit', edit), '')
  assert.ok(denied(run('Edit', edit, 'C1:1.2#side-dream')))
})

test('both runners call the one refusal chain, so a rule added there reaches both', () => {
  for (const f of ['../private-data-guard.ts', '../../src/runtime/sdk-sessions.ts'])
    assert.match(readFileSync(new URL(f, import.meta.url), 'utf8'), /\btoolRefusal\(/, f)
})
