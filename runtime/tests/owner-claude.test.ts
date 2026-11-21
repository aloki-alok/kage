import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ownerClaude } from '../owner-claude.ts'

test("the owner's Claude Code model, effort and user MCP servers are read from their home, or CLAUDE_CONFIG_DIR (#506)", () => {
  const home = mkdtempSync(join(tmpdir(), 'kage-owner-claude-'))
  mkdirSync(join(home, '.claude'))
  writeFileSync(join(home, '.claude/settings.json'), JSON.stringify({ model: 'opus[1m]', effortLevel: 'high', env: { SECRET: 'x' } }))
  writeFileSync(join(home, '.claude.json'), JSON.stringify({ mcpServers: { linear: { command: 'linear-mcp' } }, projects: {} }))
  assert.deepEqual(ownerClaude({ HOME: home }), { model: 'opus[1m]', effort: 'high', mcp: { linear: { command: 'linear-mcp' } } })
  const other = mkdtempSync(join(tmpdir(), 'kage-claude-dir-'))
  writeFileSync(join(other, 'settings.json'), JSON.stringify({ model: 'sonnet' }))
  assert.deepEqual(ownerClaude({ HOME: home, CLAUDE_CONFIG_DIR: other }), { model: 'sonnet', effort: undefined, mcp: {} })
  assert.deepEqual(ownerClaude({ HOME: join(home, 'missing') }), { model: undefined, effort: undefined, mcp: {} })
  writeFileSync(join(home, '.claude/settings.json'), 'null')
  writeFileSync(join(home, '.claude.json'), JSON.stringify({ mcpServers: ['linear'] }))
  assert.deepEqual(ownerClaude({ HOME: home }), { model: undefined, effort: undefined, mcp: {} })
})
