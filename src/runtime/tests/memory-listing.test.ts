import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listMemory } from '../memory-listing.ts'

test('the listing holds top-level notes before archive files, with size and date, and skips dot files and folders', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mem-'))
  try {
    mkdirSync(join(dir, '.archive/snapshots'), { recursive: true })
    writeFileSync(join(dir, 'a.md'), 'x'.repeat(2048))
    writeFileSync(join(dir, 'b.md'), 'y')
    writeFileSync(join(dir, '.archive/old.md'), 'z')
    writeFileSync(join(dir, '.archive/snapshots/s.tgz'), 'z')
    writeFileSync(join(dir, '.secret'), 'no')
    writeFileSync(join(dir, '.dream-ledger.tsv'), 'row')
    utimesSync(join(dir, 'a.md'), new Date('2026-11-10T12:00:00Z'), new Date('2026-11-10T12:00:00Z'))
    assert.deepEqual(listMemory(dir, true)?.map(f => f.name), ['.dream-ledger.tsv', 'a.md', 'b.md', '.archive/old.md'])
    assert.deepEqual(listMemory(dir, true)?.find(f => f.name === 'a.md'), { name: 'a.md', kb: 2, date: '2026-11-10' })
    assert.deepEqual(listMemory(dir, false)?.map(f => f.name), ['.dream-ledger.tsv', 'a.md', 'b.md'])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('a missing folder lists as empty', () => {
  assert.deepEqual(listMemory('/nonexistent-kage-mem', true), [])
})

test('a memory path that exists but cannot be read as a folder lists as not readable, not as empty', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mem-'))
  try {
    writeFileSync(join(dir, 'memory'), 'a file where the folder should be')
    assert.equal(listMemory(join(dir, 'memory'), false), undefined)
    mkdirSync(join(dir, 'own'))
    writeFileSync(join(dir, 'own', '.archive'), 'not a folder')
    assert.equal(listMemory(join(dir, 'own'), true), undefined)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
