import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newLines } from '../transcript-tail.ts'

test('only complete new lines are read; a half-written line waits for the next read', () => {
  const f = join(mkdtempSync(join(tmpdir(), 'kage-tr-')), 't.jsonl')
  writeFileSync(f, 'a\nb\npart')
  const one = newLines(f, 0)
  assert.deepEqual(one.lines, ['a', 'b'])
  appendFileSync(f, 'ial\n')
  assert.deepEqual(newLines(f, one.offset).lines, ['partial'])
  assert.deepEqual(newLines(join(f, 'missing'), 0), { lines: [], offset: 0 })
})
test('a transcript replaced by a shorter one is read again from the top', () => {
  const f = join(mkdtempSync(join(tmpdir(), 'kage-tr-')), 't.jsonl')
  writeFileSync(f, 'long line one\nlong line two\n')
  const { offset } = newLines(f, 0)
  writeFileSync(f, 'new\n')
  assert.deepEqual(newLines(f, offset).lines, ['new'])
})
