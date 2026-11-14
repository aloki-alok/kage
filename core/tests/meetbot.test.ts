import { test } from 'node:test'
import assert from 'node:assert/strict'
import { meetLink, parseSegments } from '../meetbot.ts'

test('a Meet link is kept only for meet.google.com codes, in one canonical form', () => {
  assert.equal(meetLink('https://meet.google.com/abc-defg-hij'), 'https://meet.google.com/abc-defg-hij')
  assert.equal(meetLink('meet.google.com/abc-defg-hij?authuser=1'), 'https://meet.google.com/abc-defg-hij')
  assert.equal(meetLink('<https://meet.google.com/ABC-DEFG-HIJ>'), 'https://meet.google.com/abc-defg-hij')
  assert.equal(meetLink('http://meet.google.com/abc-defg-hij'), 'https://meet.google.com/abc-defg-hij')
  for (const bad of ['https://meet.google.com.evil.example/abc-defg-hij', 'https://evil.example/meet.google.com/abc-defg-hij',
    'https://meet.google.com/abc-defg-hij/../x', 'https://meet.google.com/new', 'https://meet.google.com/abcdefghij', 'javascript:alert(1)', ''])
    assert.equal(meetLink(bad), undefined, bad)
})

test('segments from the bot become speaker lines: one line each, capped, empty ones dropped', () => {
  const s = parseSegments({ call: 'abc-defg-hij', segments: [
    { speaker: 'Jane', text: '  Kage,\nwhat is   next? ' },
    { speaker: '', text: 'hello' },
    { speaker: 'Kim', text: '   ' },
    { speaker: 'Kim', text: 'x'.repeat(5000) },
    { text: 7 },
  ] })!
  assert.equal(s.call, 'abc-defg-hij')
  assert.deepEqual(s.lines.slice(0, 2), [{ speaker: 'Jane', text: 'Kage, what is next?' }, { speaker: 'Someone', text: 'hello' }])
  assert.equal(s.lines.length, 3)
  assert.equal(s.lines[2]!.text.length, 2000)
})

test('a body with no call id, a bad call id or no segment list is refused', () => {
  assert.equal(parseSegments({ segments: [] }), undefined)
  assert.equal(parseSegments({ call: '../x', segments: [] }), undefined)
  assert.equal(parseSegments({ call: 'abc-defg-hij' }), undefined)
  assert.equal(parseSegments(null), undefined)
  assert.equal(parseSegments({ call: 'abc-defg-hij', segments: Array(201).fill({ speaker: 'a', text: 'b' }) }), undefined)
})
