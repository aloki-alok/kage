import { test } from 'node:test'
import assert from 'node:assert/strict'
import { liveTools, needsChanges } from '../job-needs.ts'

const server = (name: string, status: string, tools: string[] = []) => ({ name, status, tools: tools.map(t => ({ name: t })) })
const DIAL = 'mcp__claude_ai_Dialer__place_call'

test('the live tools are each connected server tool, named as a session sees it', () => {
  const tools = liveTools([server('claude.ai Dialer', 'connected', ['place_call']), server('claude.ai Gmail', 'needs-auth')])
  assert.deepEqual([...tools!], [DIAL])
})

test('while a server is still connecting, nothing is known yet', () => {
  assert.equal(liveTools([server('claude.ai Dialer', 'pending')]), undefined)
})

const job = (missing?: string[]) => ({ id: 'a1b2', place: '#alerts', needs: [DIAL], ...missing && { missing } })

test('a job whose tools are all present changes nothing', () => {
  assert.deepEqual(needsChanges([job()], new Set([DIAL])), [])
})

test('the first miss tells the owner once, with the job and the missing tool', () => {
  const [c] = needsChanges([job()], new Set())
  assert.deepEqual(c!.missing, [DIAL])
  assert.match(c!.dm!, /a1b2 in #alerts/)
  assert.match(c!.dm!, /mcp__claude_ai_Dialer__place_call/)
  assert.deepEqual(needsChanges([job([DIAL])], new Set()), [], 'a second look while still missing says nothing')
})

test('the tool coming back tells the owner once more', () => {
  const [c] = needsChanges([job([DIAL])], new Set([DIAL]))
  assert.deepEqual(c!.missing, [])
  assert.match(c!.dm!, /a1b2 .*again/)
})

test('a job with no needs is never checked', () => {
  assert.deepEqual(needsChanges([{ id: 'x', place: '#a', needs: [] }], new Set()), [])
})
