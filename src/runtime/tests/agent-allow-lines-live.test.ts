import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { query, type HookCallback } from '@anthropic-ai/claude-agent-sdk'
import { agentToolRefusal } from '../../core/guards.ts'

const which = (c: string) => { try { return execFileSync('which', [c], { encoding: 'utf8' }).trim() } catch { return '' } }
const claude = which('claude')
const skip = process.env.KAGE_LIVE_TESTS !== '1' ? 'set KAGE_LIVE_TESTS=1 to run: it starts a real Claude Code' : !claude ? 'no claude command' : false

async function shell(o: { hook: boolean }) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kage-518-')))
  const proof = `${root}/proof`
  let refused = 0
  const agentHook: HookCallback = async input => {
    const reason = agentToolRefusal((input as { tool_name: string }).tool_name, 'agent')
    if (!reason) return {}
    refused++
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }
  }
  const run = query({
    prompt: `Run this exact shell command with the Bash tool, once, then stop: echo kage > ${proof}`,
    options: {
      cwd: root, settingSources: [], pathToClaudeCodeExecutable: claude, maxTurns: 3,
      settings: { permissions: { defaultMode: 'auto', allow: [`Bash(echo kage > ${proof})`] } },
      canUseTool: async () => ({ behavior: 'deny', message: 'canUseTool was asked, so the allow line did not apply' }),
      ...o.hook && { hooks: { PreToolUse: [{ hooks: [agentHook] }] } },
    },
  })
  for await (const _ of run) void _
  return { ran: existsSync(proof), refused }
}

test("an owner allow line and auto mode do not let an agent's task run a shell command, because the hook refuses it first (#518)", { skip, timeout: 240_000 }, async () => {
  const control = await shell({ hook: false })
  assert.ok(control.ran, 'without the hook the allow line runs the command, so the next check is not empty')
  const guarded = await shell({ hook: true })
  assert.ok(guarded.refused >= 1, 'the hook saw the Bash call')
  assert.equal(guarded.ran, false, 'the command did not run')
})
