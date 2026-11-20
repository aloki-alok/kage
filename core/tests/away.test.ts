import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { awayFacts, awayLines, awaySince } from '../away.ts'
import type { KageEvent } from '../events.ts'
import type { KageletRow } from '../kagelets/kagelet.ts'

const NOW = Date.parse('2026-11-19T18:00:00Z')
const SINCE = Date.parse('2026-11-19T09:00:00Z')
const at = (iso: string) => `2026-11-19T${iso}:00.000Z`
const tsv = (rows: string[][]) => rows.map(r => r.join('\t')).join('\n')
const kagelet = (name: string, state: KageletRow['state']): KageletRow => ({ name, state, tools: [], costToday: 0, avg7: 0 })
const event = (when: string, kind: KageEvent['kind'], detail: string): KageEvent => ({ at: at(when), kind, who: 'news', trace: '', chain: '', detail, transcript: '' })

const base = {
  posted: tsv([
    [at('08:00'), 'C0TEST1', '1.1', 'bot', 'C0TEST1:1.0'],
    [at('10:00'), 'C0TEST1', '2.1', 'bot', 'C0TEST1:1.0'],
    [at('11:00'), 'C0TEST2', '3.1', 'owner', 'C0TEST2:3.0'],
    [at('11:30'), 'C0TEST4', '7.2', 'bot', 'C0TEST4:7.0'],
    [at('12:00'), 'D0TEST1', '4.1', 'card', 'p1'],
    [at('12:30'), 'C0TEST1', '2.1', 'deleted'],
  ]),
  costs: tsv([[at('08:30'), 'C0TEST1:1.0', '0.50', '0.50'], [at('10:00'), 'C0TEST1:1.0', '0.25', '0.75'], [at('11:00'), 'C0TEST2:3.0', '1.10', '1.10']]),
  runs: tsv([[at('08:00'), 'kagelet-news', 'k'], [at('10:00'), 'kagelet-news', 'k'], [at('11:00'), 'kagelet-digest', 'k'], [at('11:30'), 'job-1', 'C0TEST1:1.0'], [at('11:40'), 'kageletnews', 'k']]),
  waiting: tsv([[at('13:00'), 'open', 'D0TEST2:5.0', 'https://x.test/p', 'send the invite to Priya?'], [at('07:00'), 'open', 'C0TEST3:6.0', 'https://x.test/q', 'old ask'], [at('07:30'), 'answered', 'C0TEST3:6.0', '', '']]),
  events: [event('10:00', 'memory-decision', 'approved notes/deploys.md'), event('10:05', 'memory-decision', 'rejected notes/x.md: too vague'), event('08:00', 'memory-decision', 'edited notes/old.md')],
  kagelets: [kagelet('news', 'runs'), kagelet('digest', 'runs'), kagelet('invoices', 'paused'), kagelet('bad', 'broken')],
  since: SINCE, now: NOW,
}

describe('awayFacts: what happened since the owner last looked', () => {
  test('counts only what happened after since', () => {
    assert.deepEqual(awayFacts(base), {
      hours: 9, replies: 3, threads: 3, usd: 1.35, kageletRuns: 2, lessons: 1,
      needsYou: [{ what: 'send the invite to Priya?', thread: 'D0TEST2:5.0' }],
      kagelets: { on: 2, total: 4 },
    })
  })
  test('cards, canvases and deletions are not replies', () => {
    assert.equal(awayFacts({ ...base, posted: tsv([[at('12:00'), 'D0TEST1', '4.1', 'card', 'p1'], [at('12:10'), 'C0TEST1', '9.9', 'canvas', 'k']]) }).replies, 0)
  })
  test('a broken row or a NaN time counts as nothing, never throws', () => {
    const f = awayFacts({ ...base, posted: 'junk\n\t\t', costs: 'x\ty\tz', runs: '\n', waiting: '', events: [], kagelets: [] })
    assert.deepEqual([f.replies, f.usd, f.kageletRuns, f.needsYou.length, f.kagelets.total], [0, 0, 0, 0, 0])
  })
})

describe('awayLines: the home screen in Kage words', () => {
  test('a busy stretch: what Kage did, then what needs you, then the kagelets', () => {
    const l = awayLines(awayFacts(base))
    assert.equal(l.head, 'While you were away (9 h)')
    assert.deepEqual(l.did, ['answered 3 times in 3 threads', 'ran kagelets 2 times', 'kept 1 new lesson', 'spent $1.35'])
    assert.deepEqual(l.needsYou, ['send the invite to Priya?'])
    assert.equal(l.kagelets, '2 of 4 kagelets on')
  })
  test('one of each reads in the singular', () => {
    const l = awayLines({ hours: 1, replies: 1, threads: 1, usd: 0.05, kageletRuns: 1, lessons: 0, needsYou: [], kagelets: { on: 1, total: 1 } })
    assert.equal(l.head, 'While you were away (1 h)')
    assert.deepEqual(l.did, ['answered once in 1 thread', 'ran kagelets once', 'spent $0.05'])
    assert.equal(l.kagelets, '1 of 1 kagelet on')
  })
  test('nothing happened: says so, nothing for you, no kagelets line without kagelets', () => {
    const l = awayLines({ hours: 0, replies: 0, threads: 0, usd: 0, kageletRuns: 0, lessons: 0, needsYou: [], kagelets: { on: 0, total: 0 } })
    assert.equal(l.head, 'Since you last looked')
    assert.deepEqual(l.did, ['all quiet, nothing came in'])
    assert.deepEqual(l.needsYou, [])
    assert.equal(l.kagelets, undefined)
  })
  test('more than three asks: three shown and a count of the rest', () => {
    const asks = Array.from({ length: 5 }, (_, i) => ({ what: `ask ${i}`, thread: `C0TEST1:${i}` }))
    assert.deepEqual(awayLines({ ...awayFacts(base), needsYou: asks }).needsYou, ['ask 0', 'ask 1', 'ask 2', 'and 2 more (kage top)'])
  })
})

describe('awaySince: where the stretch starts', () => {
  test('the last look, kept within a week', () => {
    assert.equal(awaySince('1795000000000', 1795010000000), 1795000000000)
    assert.equal(awaySince(String(NOW - 30 * 86_400_000), NOW), NOW - 7 * 86_400_000)
  })
  test('no file, junk or a time in the future: the last 24 hours', () => {
    for (const raw of [undefined, '', 'junk', String(NOW + 1000)]) assert.equal(awaySince(raw, NOW), NOW - 86_400_000, String(raw))
  })
})
