import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { countBoot, noteExit } from '../hub-log.ts'

const fresh = () => mkdtempSync(join(tmpdir(), 'kage-boots-'))

test('each start records why the hub stopped before it, and the note is used once (#255)', () => {
  const dir = fresh()
  assert.equal(countBoot(dir, 1000), 1)
  noteExit(dir, 'update')
  countBoot(dir, 1100)
  countBoot(dir, 1200)
  noteExit(dir, 'crash', new TypeError('x is undefined\n    at foo (a.ts:1)'))
  countBoot(dir, 1300)
  assert.equal(readFileSync(join(dir, 'boots'), 'utf8'), '1000 first\n1100 update\n1200 unknown\n1300 crash TypeError: x is undefined\n')
})

test('starts older than a day drop off, an old line with no cause is kept, and the count is the last 10 minutes', () => {
  const dir = fresh()
  writeFileSync(join(dir, 'boots'), '10\n90000\n')
  noteExit(dir, 'restart')
  assert.equal(countBoot(dir, 90_100), 2)
  assert.equal(readFileSync(join(dir, 'boots'), 'utf8'), '90000\n90100 restart\n')
})

test('a long crash line is cut to one line of 160 characters', () => {
  const dir = fresh()
  countBoot(dir, 1)
  noteExit(dir, 'crash', new Error('y'.repeat(400)))
  countBoot(dir, 2)
  assert.equal(readFileSync(join(dir, 'boots'), 'utf8').split('\n')[1], `2 crash Error: ${'y'.repeat(153)}`)
})
