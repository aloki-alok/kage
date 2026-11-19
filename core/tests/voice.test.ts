import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PALETTE, painter, spokenStep } from '../voice.ts'

describe('painter: Kage speaks in one voice', () => {
  test('with color: a red mark for Kage, gold commands, a green check', () => {
    const v = painter(true)
    assert.equal(v.says('Got it.'), `\x1b[38;2;${PALETTE.red}m◆\x1b[0m Got it.`)
    assert.equal(v.command('kage top'), `\x1b[38;2;${PALETTE.gold}mkage top\x1b[0m`)
    assert.equal(v.ok('saved'), `\x1b[38;2;${PALETTE.green}m✓\x1b[0m saved`)
    assert.equal(v.dim('later'), '\x1b[2mlater\x1b[22m')
  })
  test('without color: the same words, no escape codes', () => {
    const v = painter(false)
    assert.equal(v.says('Got it.'), '◆ Got it.')
    assert.equal(v.point('New thing'), '  › New thing')
    assert.equal(v.command('kage top') + v.dim('x') + v.ok('y'), 'kage topx✓ y')
  })
  test('the shell uses the same palette', () => {
    const sh = readFileSync(join(import.meta.dirname, '..', '..', 'setup.sh'), 'utf8')
    for (const rgb of Object.values(PALETTE)) assert.ok(sh.includes(rgb), `setup.sh lacks ${rgb}`)
  })
})

describe('spokenStep: a session step in Kage\'s own words', () => {
  test('a task and a reply', () => {
    assert.deepEqual(spokenStep({ kind: 'task', text: 'Task from Sam: check the deploy' }), { text: 'Task from Sam: check the deploy', tone: 'loud' })
    assert.deepEqual(spokenStep({ kind: 'reply', text: 'Done: 3 calls fixed' }), { text: 'I replied: Done: 3 calls fixed', tone: 'red' })
    assert.deepEqual(spokenStep({ kind: 'error', text: 'permission denied' }), { text: 'Hit an error: permission denied', tone: 'red' })
  })
  test('tools read as what Kage did', () => {
    assert.equal(spokenStep({ kind: 'Read', text: '/a/b.ts' }).text, 'I read /a/b.ts')
    assert.equal(spokenStep({ kind: 'Bash', text: 'Show status' }).text, 'I ran: Show status')
    assert.equal(spokenStep({ kind: 'Edit', text: '/a/b.ts' }).text, 'I edited /a/b.ts')
    assert.equal(spokenStep({ kind: 'Grep', text: 'TODO' }).text, 'I searched for TODO')
    assert.equal(spokenStep({ kind: 'slack read thread', text: '' }).text, 'I used slack read thread')
    assert.equal(spokenStep({ kind: 'schedule', text: 'run the review' }).text, 'I used schedule: run the review')
    assert.equal(spokenStep({ kind: 'Read', text: '/a' }).tone, 'quiet')
  })
  test('its own thinking is quiet', () => {
    assert.deepEqual(spokenStep({ kind: 'says', text: 'Looking at it.' }), { text: 'Looking at it.', tone: 'quiet' })
  })
})
