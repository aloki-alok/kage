import { test } from 'node:test'
import assert from 'node:assert/strict'
import { stepTime, transcriptLine, transcriptSteps } from '../transcript.ts'

const line = (o: object) => JSON.stringify(o)
const assistant = (...content: object[]) => line({ type: 'assistant', message: { content } })

test('a task shows its instruction line, not the channel tag or the quoted conversation', () => {
  const task = '<channel source="kage" channel="C1" thread_ts="5.5" place="#general" permalink="">\nTask from Sam: check the deploy\n> [owner 1.1] earlier\n</channel>'
  assert.equal(transcriptLine(line({ type: 'user', message: { content: task } })), 'task  Task from Sam: check the deploy')
  assert.equal(transcriptLine(line({ type: 'user', message: { content: 'Run the 15-min watch' } })), 'input Run the 15-min watch')
})
test("Kage's own replies, other tools and text each get one short line", () => {
  assert.equal(transcriptLine(assistant({ type: 'tool_use', name: 'mcp__kage__reply', input: { channel: 'C1', text: 'Done: 3 calls fixed\nmore' } })), 'reply Done: 3 calls fixed')
  assert.equal(transcriptLine(assistant({ type: 'tool_use', name: 'mcp__plugin_kage_kage__reply', input: { text: 'hi' } })), 'reply hi')
  assert.equal(transcriptLine(assistant({ type: 'tool_use', name: 'Bash', input: { command: 'git status', description: 'Show status' } })), 'Bash  Show status')
  assert.equal(transcriptLine(assistant({ type: 'tool_use', name: 'Read', input: { file_path: '/a/b.ts' } })), 'Read  /a/b.ts')
  assert.equal(transcriptLine(assistant({ type: 'text', text: 'Looking at it.' })), 'says  Looking at it.')
  assert.equal(transcriptLine(assistant({ type: 'text', text: 'x'.repeat(300) }))!.length, 126)
})
test('a tool from another MCP server reads as words, without its server prefix or a trailing gap', () => {
  assert.equal(transcriptLine(assistant({ type: 'tool_use', name: 'mcp__claude_ai_Slack__slack_read_thread', input: { channel_id: 'C1' } })), 'slack read thread')
  assert.equal(transcriptLine(assistant({ type: 'tool_use', name: 'mcp__kage__schedule', input: { prompt: 'run the account review' } })), 'schedule run the account review')
})
test('a step carries the time it was written, so a backlog shows when each step ran', () => {
  assert.equal(stepTime(line({ type: 'assistant', timestamp: '2026-11-04T08:30:00.000Z', message: { content: [] } })), Date.parse('2026-11-04T08:30:00.000Z'))
  assert.equal(stepTime(line({ type: 'assistant', message: { content: [] } })), undefined)
  assert.equal(stepTime('not json'), undefined)
})
test('a failed tool shows; thinking, successful results and bookkeeping lines do not', () => {
  assert.equal(transcriptLine(line({ type: 'user', message: { content: [{ type: 'tool_result', is_error: true, content: 'permission denied' }] } })), 'error permission denied')
  assert.equal(transcriptLine(line({ type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] } })), undefined)
  assert.equal(transcriptLine(assistant({ type: 'thinking', thinking: 'hmm' })), undefined)
  assert.equal(transcriptLine(line({ type: 'system', subtype: 'turn_duration' })), undefined)
  assert.equal(transcriptLine('not json'), undefined)
})

test('transcriptSteps gives each step its kind and text, so the label can hold spaces', () => {
  assert.deepEqual(transcriptSteps(assistant({ type: 'tool_use', name: 'mcp__claude_ai_Slack__slack_read_thread', input: { channel_id: 'C1' } })), [{ kind: 'slack read thread', text: '' }])
  assert.deepEqual(transcriptSteps(assistant({ type: 'tool_use', name: 'Read', input: { file_path: '/a/b.ts' } })), [{ kind: 'Read', text: '/a/b.ts' }])
  assert.deepEqual(transcriptSteps('not json'), [])
})
