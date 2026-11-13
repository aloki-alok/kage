import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { suggest } from './cli-help.ts'

// setup.sh is the kage command: its help table and its case list must name the same commands.
describe('every command kage lists is one it runs, and the other way', () => {
  const sh = readFileSync(new URL('../setup.sh', import.meta.url), 'utf8')
  const table = /COMMANDS='([\s\S]*?)'/.exec(sh)![1]!.split('\n').map(l => l.split('|')[1]!)
  const cases = [...sh.slice(sh.lastIndexOf('case "${1:-}" in')).matchAll(/^  ([a-z-]+)\)/gm)].map(m => m[1]!)
  const notListed = new Set(['help', 'export-crons'])   // help explains itself; export-crons is a one-time move
  test('the help table and the case list match', () => {
    assert.deepEqual([...table].sort(), cases.filter(c => !notListed.has(c)).sort())
  })
})

describe('a mistyped command gets the closest real one', () => {
  const names = ['attach', 'start', 'stop', 'status', 'doctor', 'watch', 'top', 'remove']
  test('one or two letters off finds it', () => {
    assert.equal(suggest('atach', names), 'attach')
    assert.equal(suggest('docter', names), 'doctor')
    assert.equal(suggest('stats', names), 'status')
    assert.equal(suggest('stauts', names), 'status')        // two letters swapped is one slip
    assert.equal(suggest('dcotor', names), 'doctor')
  })
  test('a start of a name finds the one name it starts', () => {
    assert.equal(suggest('rem', names), 'remove')
    assert.equal(suggest('doc', names), 'doctor')
  })
  test('nothing close gives nothing, rather than a wild guess', () => {
    assert.equal(suggest('deploy', names), undefined)
  })
  test('a start shared by several names is no answer', () => {
    assert.equal(suggest('st', names), undefined)
  })
})
