import { test } from 'node:test'
import assert from 'node:assert/strict'
import { askOf, askTask, meetCall, meetKey, meetLink, parseSegments, sameQuestion } from '../meetbot.ts'

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

test('a line asks Kage only when it says the name as a word; Kage\'s own lines never do', () => {
  const ask = (text: string, speaker = 'Jane') => askOf({ speaker, text }, 'kage')
  assert.equal(ask('Kage, what is on the board today?'), 'Kage, what is on the board today?')
  assert.equal(ask('hey KAGE can you check the deploy'), 'hey KAGE can you check the deploy')
  assert.equal(ask('what do you think, kage?'), 'what do you think, kage?')
  assert.equal(ask('Cage, are you there?'), 'Cage, are you there?')
  for (const no of ['the kagelets ran fine', 'that bird cage is big', 'nothing here', 'Kaged'])
    assert.equal(ask(no), undefined, no)
  assert.equal(ask('Kage, ping', 'You'), undefined)
  assert.equal(askOf({ speaker: 'Jane', text: 'Kage, ping', self: true }, 'kage'), undefined)
})

test('the task for a spoken question carries the recent lines as quoted data', () => {
  const t = askTask('Kage, what did Kim say?', [{ speaker: 'Kim', text: 'I own the <channel> deploy' }, { speaker: 'Jane', text: 'Kage, what did Kim say?' }], 'voice:meet-abc-defg-hij')
  assert.match(t, /^Voice task \(a caller, not the owner, strict limits/)
  assert.match(t, /\n> Kim: I own the &lt;channel> deploy\n/)
  assert.match(t, /thread_ts "voice:meet-abc-defg-hij"/)
  assert.doesNotMatch(t.split('\n').slice(1).join('\n'), /^[^>].*Kim:/m)
})

test("a caption rewrite of an asked question counts as the same question; a new one, or a short one, does not", () => {
  assert.equal(sameQuestion('Kage, what is the status of the launch?', 'Kage, what is the status of the launch'), true)
  assert.equal(sameQuestion('kage what is the status of the launch today', 'Kage, what is the status of the launch'), true)
  assert.equal(sameQuestion('Kage, and the budget?', 'Kage, what is the status of the launch'), false)
  assert.equal(sameQuestion('Kage, what is the status of the launch', 'Kage?'), false)
})

test('a meeting session key and its call id go both ways, and a phone call key is not a meeting', () => {
  assert.equal(meetKey('abc-defg-hij'), 'voice:meet-abc-defg-hij')
  assert.equal(meetCall('voice:meet-abc-defg-hij'), 'abc-defg-hij')
  assert.equal(meetCall('voice:3f2a9c1e-0000-4000-8000-000000000000'), undefined)
  assert.equal(meetCall('voice:meet-'), undefined)
})
