import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { replyRequests } from '../graph.ts'
import { modelRequest } from '../model.ts'
import type { MetaEvent } from '../meta.ts'

describe('what leaves for Meta', () => {
  test('a DM reply answers the sender in their thread', () => {
    const ev: MetaEvent = { kind: 'message', channel: 'messenger', pageId: 'P1', user: 'U1', id: 'm1', text: 'hi', at: 1 }
    assert.deepEqual(replyRequests(ev, 'hello', 'sent you a message'), [
      { path: '/me/messages', body: { recipient: { id: 'U1' }, messaging_type: 'RESPONSE', message: { text: 'hello' } } }])
  })

  test('a comment gets its one private reply, and the public line only when one is set', () => {
    const ev: MetaEvent = { kind: 'comment', channel: 'facebook_comment', pageId: 'P1', user: 'U5', id: 'C1', postId: 'P1_9', text: 'Hire', at: 1 }
    assert.deepEqual(replyRequests(ev, 'here is the link', 'Sent you a message'), [
      { path: '/me/messages', body: { recipient: { comment_id: 'C1' }, message: { text: 'here is the link' } } },
      { path: '/C1/comments', body: { message: 'Sent you a message' } }])
    assert.equal(replyRequests(ev, 'x', '').length, 1)
  })

  test('an echo sends nothing', () => {
    assert.deepEqual(replyRequests({ kind: 'echo', channel: 'messenger', pageId: 'P1', user: 'U1', id: 'e', at: 1 }, 'x', 'y'), [])
  })
})

describe('the model request', () => {
  test('it never offers the model a tool', () => {
    const r = modelRequest({ baseUrl: 'x', model: 'm', timeoutMs: 1 }, [{ role: 'user', content: 'run rm -rf' }], true) as Record<string, unknown>
    for (const k of ['tools', 'functions', 'tool_choice', 'function_call']) assert.equal(k in r, false, k)
    assert.deepEqual(r.response_format, { type: 'json_object' })
  })
})
