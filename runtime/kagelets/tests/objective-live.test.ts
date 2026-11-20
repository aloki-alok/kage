import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSdkMcpServer, query, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { instructions } from '../../../core/instructions.ts'
import { scoreboard, type Objective, type Reading } from '../../../core/objective.ts'
import { kageletPrompt } from '../sync.ts'

const which = (c: string) => { try { return execFileSync('which', [c], { encoding: 'utf8' }).trim() } catch { return '' } }
const claude = which('claude')
const skip = process.env.KAGE_LIVE_TESTS !== '1' ? 'set KAGE_LIVE_TESTS=1 to run: it calls a real model' : !claude ? 'no claude command' : false

const P1S: Objective = { objective: 'No open P1 incidents', measure: './count-p1s.sh', target: { op: '<=', n: 0 } }
const JOB = 'Watch the open P1 incidents. You cannot change them yourself: each run, look at what the number did, decide what to check or ask for next, and report.'

test('a kagelet whose number moves between runs reports the change and its next step, and changes its plan when the number stalls (#427)', { skip, timeout: 600_000 }, async () => {
  const work = realpathSync(mkdtempSync(join(tmpdir(), 'kage-goal-')))
  const reports: string[] = []
  const server = createSdkMcpServer({ name: 'kage', tools: [tool('report', 'End every run with this: one line for your manager on what you found or did.', { summary: z.string(), next: z.string(), needs: z.string().optional() }, async a => {
    reports.push(`${a.summary} Next: ${a.next}${a.needs ? ` | needs: ${a.needs}` : ''}`)
    return { content: [{ type: 'text', text: 'reported' }] }
  })] })
  let session: string | undefined
  const run = async (readings: Reading[]) => {
    const before = reports.length
    const q = query({
      prompt: `${scoreboard(P1S, readings)}\n\n${kageletPrompt({ name: 'p1watch', job: JOB })}`,
      options: {
        cwd: work, model: 'haiku', maxTurns: 6, settingSources: [], pathToClaudeCodeExecutable: claude, tools: [],
        systemPrompt: { type: 'preset', preset: 'claude_code', append: instructions('Kage', { own: `${work}/mem`, owner: `${work}/owner` }, false, { kagelet: 'p1watch' }) },
        mcpServers: { kage: server }, allowedTools: ['mcp__kage__report'], permissionMode: 'dontAsk', ...session && { resume: session },
      },
    })
    for await (const m of q) if ('session_id' in m && m.session_id) session = m.session_id
    assert.ok(reports.length > before, 'the run ended without a report')
    return reports.at(-1)!
  }
  await run([{ at: 0, value: 7 }])
  const fell = await run([{ at: 0, value: 7 }, { at: 1, value: 4 }])
  assert.match(fell, /\b7\b[^|]*\b4\b|\b4\b[^|]*\b7\b|down 3/i, `the change is named: ${fell}`)
  assert.match(fell, /Next: \S/, `a next step is named: ${fell}`)
  const stalled = await run([{ at: 0, value: 7 }, { at: 1, value: 4 }, { at: 2, value: 4 }])
  assert.match(stalled, /no change|unchanged|did not move|didn't move|still 4|stayed|flat|stalled/i, `the stall is named: ${stalled}`)
  assert.notEqual(stalled.toLowerCase(), fell.toLowerCase(), 'the plan changed after the stall')
})
