import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { FLICKER, MARK, SKIN, painter, spokenStep } from '../voice.ts'

describe('painter: the kitsunebi skin', () => {
  test('foxfire for Kage and its work, the lantern only for you', () => {
    const v = painter(true)
    assert.equal(v.says('Got it.'), `\x1b[38;2;${SKIN.fire}m${MARK.kage}\x1b[0m Got it.`)
    assert.equal(v.needsYou('send the invite?'), `\x1b[38;2;${SKIN.lantern}m${MARK.you} send the invite?\x1b[0m`)
    assert.equal(v.command('kage top'), `\x1b[38;2;${SKIN.fire}mkage top\x1b[0m`)
    assert.equal(v.ok('saved'), `\x1b[38;2;${SKIN.fire}m✓\x1b[0m saved`)
    assert.equal(v.dim('later'), '\x1b[2mlater\x1b[22m')
  })
  test('without color: the same marks and words, no escape codes', () => {
    const v = painter(false)
    assert.equal(v.says('Got it.'), '✦ Got it.')
    assert.equal(v.needsYou('yes?'), '◆ yes?')
    assert.equal(v.point('New thing'), '  · New thing')
    assert.equal(v.command('kage top') + v.dim('x') + v.ok('y') + v.fire('z'), 'kage topx✓ yz')
  })
  test('each state has its own shape, so it reads with no color', () => {
    assert.deepEqual(MARK, { kage: '✦', working: '•', you: '◆', quiet: '◌' })
    assert.equal(new Set(Object.values(MARK)).size, 4)
    assert.deepEqual(FLICKER, ['⋅', '∙', '•', '∙'])
  })
  test('no red: the skin is foxfire and lantern only', () => {
    assert.deepEqual(Object.keys(SKIN), ['fire', 'lantern'])
  })
  test('the shell uses the same skin', () => {
    const sh = readFileSync(join(import.meta.dirname, '..', '..', 'setup.sh'), 'utf8')
    for (const rgb of Object.values(SKIN)) assert.ok(sh.includes(rgb), `setup.sh lacks ${rgb}`)
    for (const m of [MARK.kage, MARK.you]) assert.ok(sh.includes(m), `setup.sh lacks ${m}`)
    assert.ok(sh.includes(`(${FLICKER.map(f => `'${f}'`).join(' ')})`), 'setup.sh flickers other frames')
    assert.ok(!sh.includes('255;77;61'), 'setup.sh still has the old red')
  })
})

describe('spokenStep: a session step in Kage\'s own words', () => {
  test('a task and a reply', () => {
    assert.deepEqual(spokenStep({ kind: 'task', text: 'Task from Sam: check the deploy' }), { text: 'Task from Sam: check the deploy', tone: 'plain' })
    assert.deepEqual(spokenStep({ kind: 'reply', text: 'Done: 3 calls fixed' }), { text: 'I replied: Done: 3 calls fixed', tone: 'fire' })
    assert.deepEqual(spokenStep({ kind: 'error', text: 'permission denied' }), { text: 'Hit an error: permission denied', tone: 'you' })
  })
  test('tools read as what Kage did', () => {
    assert.equal(spokenStep({ kind: 'Read', text: '/a/b.ts' }).text, 'I read /a/b.ts')
    assert.equal(spokenStep({ kind: 'Bash', text: 'Show status' }).text, 'I ran: Show status')
    assert.equal(spokenStep({ kind: 'Edit', text: '/a/b.ts' }).text, 'I edited /a/b.ts')
    assert.equal(spokenStep({ kind: 'Grep', text: 'TODO' }).text, 'I searched for TODO')
    assert.equal(spokenStep({ kind: 'Write', text: '/a' }).text, 'I wrote /a')
    assert.equal(spokenStep({ kind: 'Glob', text: '*.ts' }).text, 'I looked for *.ts')
    assert.equal(spokenStep({ kind: 'WebFetch', text: 'https://x.test' }).text, 'I opened https://x.test')
    assert.equal(spokenStep({ kind: 'WebSearch', text: 'node 22' }).text, 'I searched the web for node 22')
    assert.equal(spokenStep({ kind: 'slack read thread', text: '' }).text, 'I used slack read thread')
    assert.equal(spokenStep({ kind: 'schedule', text: 'run the review' }).text, 'I used schedule: run the review')
    assert.equal(spokenStep({ kind: 'Read', text: '/a' }).tone, 'quiet')
  })
  test('its own thinking is quiet', () => {
    assert.deepEqual(spokenStep({ kind: 'says', text: 'Looking at it.' }), { text: 'Looking at it.', tone: 'quiet' })
  })
})
