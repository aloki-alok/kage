import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { snapshotMemory, undoToSnapshot } from '../memory-snapshot.ts'

const fresh = () => {
  const dir = mkdtempSync(`${tmpdir()}/kage-mem-`)
  writeFileSync(`${dir}/MEMORY.md`, '- [a](a.md)\n')
  writeFileSync(`${dir}/a.md`, 'old a')
  return dir
}
test('undo puts the memory back exactly as the snapshot had it, and keeps what the dream wrote', () => {
  const dir = fresh()
  const snap = snapshotMemory(dir, Date.parse('2026-11-09T21:00:00Z'))
  writeFileSync(`${dir}/a.md`, 'merged a')                         // the dream edits
  writeFileSync(`${dir}/b.md`, 'new b')                            // and adds
  mkdirSync(`${dir}/.archive`, { recursive: true })
  const back = undoToSnapshot(dir, Date.parse('2026-11-10T08:00:00Z'))
  assert.equal(back, snap)
  assert.equal(readFileSync(`${dir}/a.md`, 'utf8'), 'old a')
  assert.equal(existsSync(`${dir}/b.md`), false)
  const undone = readdirSync(`${dir}/.archive`).find(n => n.startsWith('undone-'))!
  assert.equal(readFileSync(`${dir}/.archive/${undone}/b.md`, 'utf8'), 'new b')   // nothing is lost
})
test('snapshots skip the archive, and undo with no snapshot changes nothing', () => {
  const dir = fresh()
  mkdirSync(`${dir}/.archive`)
  writeFileSync(`${dir}/.archive/big.md`, 'x')
  assert.equal(undoToSnapshot(dir, 0), undefined)
  assert.equal(readFileSync(`${dir}/a.md`, 'utf8'), 'old a')
  snapshotMemory(dir, 1000)
  const snaps = readdirSync(`${dir}/.archive/snapshots`)
  assert.equal(snaps.length, 1)
})
