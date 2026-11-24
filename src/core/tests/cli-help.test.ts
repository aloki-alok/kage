import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { suggest } from '../cli-help.ts'

describe('every command kage lists is one it runs, and the other way', () => {
  const sh = readFileSync(new URL('../../../setup.sh', import.meta.url), 'utf8')
  const table = /COMMANDS='([\s\S]*?)'/.exec(sh)![1]!.split('\n').map(l => l.split('|')[1]!)
  const renamed = new Map(/RENAMED='([\s\S]*?)'/.exec(sh)![1]!.split('\n').map(l => l.split('|') as [string, string]))
  const main = sh.slice(sh.lastIndexOf('case "${1:-}" in'))
  const blocks = new Map([...main.matchAll(/^  ([a-z-]+)\)([\s\S]*?)(?=^  [a-z-]+\)|^esac)/gm)].map(m => [m[1]!, m[2]!]))
  const verbsOf = (noun: string) => [...(blocks.get(noun) ?? '').matchAll(/^ {6}([a-z|-]+)\)/gm)].flatMap(m => m[1]!.split('|'))
  const notListed = new Set(['help', 'export-crons'])
  test('each top-level command in the help table has a case, and each case is in the table', () => {
    assert.deepEqual([...new Set(table.map(n => n.split(' ')[0]!))].sort(), [...blocks.keys()].filter(c => !notListed.has(c)).sort())
  })
  test('each noun verb in the help table is a verb its noun runs, and each verb a noun runs is in the table', () => {
    for (const noun of new Set(table.filter(n => n.includes(' ')).map(n => n.split(' ')[0]!))) {
      assert.deepEqual(table.filter(n => n.startsWith(`${noun} `)).map(n => n.split(' ')[1]!).sort(), verbsOf(noun).sort(), noun)
    }
  })
  test('an old name is never a command of its own, and points at a command the table lists', () => {
    for (const [old, now] of renamed) {
      assert.ok(!blocks.has(old), `${old} still has its own case`)
      assert.ok(table.includes(now), `${old} points at ${now}, which the table does not list`)
    }
  })
})

describe('a mistyped command gets the closest real one', () => {
  const names = ['attach', 'start', 'stop', 'status', 'doctor', 'watch', 'top', 'remove']
  test('one or two letters off finds it', () => {
    assert.equal(suggest('atach', names), 'attach')
    assert.equal(suggest('docter', names), 'doctor')
    assert.equal(suggest('stats', names), 'status')
    assert.equal(suggest('stauts', names), 'status')
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
