import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSdkMcpServer, query, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { instructions } from '../../../core/instructions.ts'
import { objectiveOf } from '../../../core/objective.ts'

const which = (c: string) => { try { return execFileSync('which', [c], { encoding: 'utf8' }).trim() } catch { return '' } }
const claude = which('claude')
const skip = process.env.KAGE_LIVE_TESTS !== '1' ? 'set KAGE_LIVE_TESTS=1 to run: it calls a real model' : !claude ? 'no claude command' : false
const SKILLS = new URL('../../../skills', import.meta.url).pathname

test("the owner's 'keep watching' ask becomes a kagelet with an objective, measure and target, and Kage says the goal it picked (#427)", { skip, timeout: 900_000 }, async () => {
  const work = realpathSync(mkdtempSync(join(tmpdir(), 'kage-watch-')))
  mkdirSync(`${work}/plugin/.claude-plugin`, { recursive: true })
  writeFileSync(`${work}/plugin/.claude-plugin/plugin.json`, '{"name":"kage"}')
  symlinkSync(SKILLS, `${work}/plugin/skills`)
  mkdirSync(`${work}/scripts`)
  writeFileSync(`${work}/scripts/open-p1s.sh`, '#!/bin/sh\necho 7\n', { mode: 0o755 })
  const saved: Record<string, unknown>[] = [], scheduled: unknown[] = [], replies: string[] = []
  const ok = (text: string) => ({ content: [{ type: 'text' as const, text }] })
  const server = createSdkMcpServer({ name: 'kage', tools: [
    tool('reply', 'Post in the task\'s thread.', { channel: z.string(), thread_ts: z.string(), text: z.string() }, async a => { replies.push(a.text); return ok('posted') }),
    tool('manage_kagelet', 'Create or change (save) a kagelet: a recurring job that runs on its own schedule in its thread and reports to you. save needs name, thread, schedule and job.', {
      action: z.string(), name: z.string(), thread: z.string().optional(), schedule: z.string().optional(), job: z.string().optional(), why: z.string().optional(),
      objective: z.string().optional().describe('save: the outcome it works toward, in plain words'), measure: z.string().optional().describe('save: a command that prints exactly one line, value: <n>'), target: z.string().optional().describe('save: a comparison the value must meet, such as <= 0'),
    }, async a => { saved.push(a); return ok('saved. The owner approves the measure on a card.') }),
    tool('schedule', 'Add a repeating job to this thread: a cron and a prompt, or a probe command that wakes you only when its output changes.', { cron: z.string(), prompt: z.string(), probe: z.string().optional() }, async a => { scheduled.push(a); return ok('scheduled') }),
  ] })
  const q = query({
    prompt: `<channel source="kage" channel="CTEST1" thread_ts="1.1" place="#ops">Task from Alex: keep watching the open P1 incidents for me. ${work}/scripts/open-p1s.sh prints how many are open.</channel>`,
    options: {
      cwd: work, model: 'sonnet', maxTurns: 20, settingSources: [], pathToClaudeCodeExecutable: claude, tools: ['Read', 'Write', 'Skill'],
      plugins: [{ type: 'local', path: `${work}/plugin` }],
      systemPrompt: { type: 'preset', preset: 'claude_code', append: instructions('Kage', { own: `${work}/mem`, owner: `${work}/owner` }, false) },
      mcpServers: { kage: server }, permissionMode: 'dontAsk',
      settings: { permissions: { allow: ['Read', 'Write', 'Skill', 'mcp__kage__reply', 'mcp__kage__manage_kagelet', 'mcp__kage__schedule'] } } as any,
    },
  })
  for await (const _ of q) {}
  const save = saved.find(s => s.action === 'save')
  assert.ok(save, `no kagelet was saved. Scheduled: ${JSON.stringify(scheduled)}. Replies: ${replies.join(' / ')}`)
  const goal = objectiveOf(new Map(['objective', 'measure', 'target'].map(k => [k, String(save![k] ?? '')])))
  assert.ok(goal && !('error' in goal), `the kagelet has no full objective: ${JSON.stringify(save)}`)
  const n = (goal as { target: { n: number } }).target.n
  assert.match(replies.join('\n'), new RegExp(`\\b${n}\\b${n === 0 ? '|zero|none' : ''}`, 'i'), `the goal it picked (${n}) is said in the thread: ${replies.join(' / ')}`)
})
