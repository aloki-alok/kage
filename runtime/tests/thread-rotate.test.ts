import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { threadRotator } from '../thread-rotate.ts'
import { taskAsOther } from '../../core/gate.ts'

const KEY = 'CTEST1:1.1'
const turn = (tokens: number, said?: string) => JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 1, cache_read_input_tokens: tokens - 1 },
  content: said ? [{ type: 'tool_use', name: 'mcp__kage__reply', input: { text: said } }] : [] } }) + '\n'
const task = () => taskAsOther({ content: 'Task from Sam: next', meta: { channel: 'CTEST1', thread_ts: '1.1', place: '#test', permalink: '' }, origin: { channel: 'CTEST1', ts: '2.2' } })

function rig(tokens: number) {
  const project = mkdtempSync(join(tmpdir(), 'kage-rotate-'))
  const ids: Record<string, string> = { [KEY]: 'S1', [`${KEY}#side-x`]: 'S9' }
  writeFileSync(join(project, 'S1.jsonl'), turn(tokens, 'first post'))
  writeFileSync(join(project, 'S9.jsonl'), turn(900_000))
  const resets: string[] = []
  let ready: 'ready' | 'busy' | 'blocked' = 'ready'
  const r = threadRotator({
    project, limit: () => 200_000, carry: () => ({ count: 5, chars: 500 }),
    idOf: k => ids[k], hasTranscript: id => id !== 'S0', ready: () => ready,
    reset: k => { resets.push(k); delete ids[k] },
  })
  return { r, project, resets, ids, setReady: (s: typeof ready) => { ready = s }, done: () => rmSync(project, { recursive: true, force: true }) }
}

test('a thread past the limit starts a new session with the carry, and reports itself not resumable so the thread is sent whole', () => {
  const t = rig(250_000)
  try {
    assert.deepEqual(t.r.sessionOf(KEY), { id: 'S1', resumable: false })
    const out = t.r.before(KEY, task())
    assert.deepEqual(t.resets, [KEY])
    assert.match(out.content, /new session[^]*S1\.jsonl[^]*> first post\nTask from Sam: next$/)
  } finally { t.done() }
})

test('a thread under the limit, a busy one, a side lane and a missing session keep their session', () => {
  const t = rig(150_000)
  try {
    assert.deepEqual(t.r.sessionOf(KEY), { id: 'S1', resumable: true })
    assert.equal(t.r.before(KEY, task()).content, 'Task from Sam: next')
    assert.equal(t.r.before(`${KEY}#side-x`, task()).content, 'Task from Sam: next')
    assert.equal(t.r.before('CTEST1:9.9', task()).content, 'Task from Sam: next')
    appendFileSync(join(t.project, 'S1.jsonl'), turn(300_000))
    t.setReady('busy')
    assert.equal(t.r.before(KEY, task()).content, 'Task from Sam: next')
    assert.deepEqual(t.resets, [])
  } finally { t.done() }
})

test('a task built as a delta for the live session is never moved to a new one, even if the limit is crossed meanwhile', () => {
  const t = rig(150_000)
  try {
    assert.deepEqual(t.r.sessionOf(KEY), { id: 'S1', resumable: true })
    appendFileSync(join(t.project, 'S1.jsonl'), turn(300_000))
    assert.equal(t.r.before(KEY, task()).content, 'Task from Sam: next')
    assert.deepEqual(t.resets, [])
    assert.match(t.r.before(KEY, task()).content, /new session/)
    assert.deepEqual(t.resets, [KEY])
  } finally { t.done() }
})
