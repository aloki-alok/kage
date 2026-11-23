import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { topicReader } from '../top-topics.ts'

test('a session whose transcript appears after its row gets its topic on a later look (#257 review)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kage-topics-'))
  const topicFor = topicReader(dir)
  assert.equal(topicFor('s1', 0), undefined)
  writeFileSync(join(dir, 's1.jsonl'), JSON.stringify({ type: 'user', message: { content: '<channel source="kage">\nTask from Sam: count the open P1s today please' } }) + '\n')
  assert.equal(topicFor('s1', 5_000), undefined, 'a miss is not read again at once')
  assert.equal(topicFor('s1', 11_000), 'count the open P1s today please')
})
