import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { query } from '@anthropic-ai/claude-agent-sdk'
import { HOOK_ENDINGS } from '../sdk-sessions.ts'

const which = (c: string) => { try { return execFileSync('which', [c], { encoding: 'utf8' }).trim() } catch { return '' } }
const claude = which('claude')
const skip = process.env.KAGE_LIVE_TESTS !== '1' ? 'set KAGE_LIVE_TESTS=1 to run: it starts a real Claude Code' : !claude ? 'no claude command' : false

test('Claude Code marks a prompt that a hook blocked the way the session loop reads it, with the hook reason', { skip, timeout: 120_000 }, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kage-hookdrop-')))
  mkdirSync(`${root}/plugin/.claude-plugin`, { recursive: true }); mkdirSync(`${root}/plugin/hooks`)
  writeFileSync(`${root}/plugin/.claude-plugin/plugin.json`, '{"name":"blocker","version":"0.0.1"}')
  writeFileSync(`${root}/plugin/hooks/hooks.json`, JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: `echo '{"decision":"block","reason":"test hook says no"}'` }] }] } }))
  const seen: unknown[] = []
  for await (const m of query({ prompt: 'say hi', options: { cwd: root, settingSources: [], plugins: [{ type: 'local', path: `${root}/plugin` }], pathToClaudeCodeExecutable: claude, maxTurns: 1 } })) seen.push(m)
  const ended = seen.map(m => m as { type: string; prompt_submit_outcome?: { kind: string; reason?: string } }).find(m => m.type === 'system' && m.prompt_submit_outcome)
  assert.ok(ended, `no system message with prompt_submit_outcome in: ${JSON.stringify(seen.map(m => (m as { type: string; subtype?: string }).subtype ?? (m as { type: string }).type))}`)
  assert.ok(HOOK_ENDINGS.includes(ended.prompt_submit_outcome!.kind), ended.prompt_submit_outcome!.kind)
  assert.equal(ended.prompt_submit_outcome!.reason, 'test hook says no')
  const result = seen.find(m => (m as { type: string }).type === 'result') as { num_turns: number }
  assert.equal(result.num_turns, 0)
})
