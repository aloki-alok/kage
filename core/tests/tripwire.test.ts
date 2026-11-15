import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { commandWords, decide, lineHasher, normalize, pinsChanged, safePattern, type JobState, type Probe } from '../tripwire.ts'

const probe: Probe = { command: 'x', pins: {}, ignore: [], reads: [] }
const sha = (t: string) => createHash('sha256').update(t).digest('hex')
const fpOf = (out: string, ignore: string[] = []) => { const h = lineHasher(ignore, 2000); h.push(out); return h.end() }
const o = { failPing: 3, lineMax: 2000 }
const ok = (out: string, ignore: string[] = []) => ({ ok: true, out, fp: fpOf(out, ignore) })
const bad = { ok: false, out: '', fp: '' }

describe('normalize and fingerprint', () => {
  test('drops lines matching an ignore regex and trims trailing space', () => {
    assert.equal(normalize('a  \nts=12\nb\t', ['^ts='], 2000), 'a\nb')
  })
  test('a line longer than lineMax is never dropped, because the pattern would see only part of it', () => {
    const line = 'a'.repeat(20) + 'z'
    assert.equal(normalize(line, ['z$'], 2000), '')
    assert.equal(normalize(line, ['z$'], 10), line)
  })
})

describe('lineHasher', () => {
  const hashed = (chunks: string[], ignore: string[] = [], lineMax = 2000) => { const h = lineHasher(ignore, lineMax); chunks.forEach(c => h.push(c)); return h.end() }
  test('gives the sha256 of the normalized text, however the output is cut into chunks', () => {
    const text = '\n\nA  \nts=1\n\nb\t\n\n'
    const want = sha(normalize(text, ['^ts='], 2000))
    assert.match(want, /^[0-9a-f]{64}$/)
    assert.equal(hashed([text], ['^ts=']), want)
    assert.equal(hashed(text.split(''), ['^ts=']), want)
  })
  test('different text gives a different hash, and an empty output the hash of empty text', () => {
    assert.notEqual(hashed(['a']), hashed(['b']))
    assert.equal(hashed([]), sha(''))
  })
  test('a long line is hashed whole and never dropped by ignore', () => {
    const line = 'a'.repeat(20) + 'z'
    assert.equal(hashed([line], ['z$'], 10), sha(line))
  })
})

describe('safePattern', () => {
  test('accepts a plain pattern', () => assert.equal(safePattern('^ts=\\d+$', 200), undefined))
  test('refuses an invalid pattern', () => assert.match(safePattern('(', 200)!, /invalid/))
  test('refuses a pattern longer than the cap', () => assert.match(safePattern('a'.repeat(11), 10)!, /long/))
  test('refuses a nested quantifier, even through an inner group', () => {
    for (const p of ['(a+)+', '(.*)*', '(a|b+)*', '((a+)b)+', '(a{2,})+']) assert.match(safePattern(p, 200)!, /nested/, p)
  })
  test('accepts a quantified group with no quantifier inside, and an escaped or class plus', () => {
    for (const p of ['(ab)+', '(a\\+)+', '([+*])+', 'a+b*']) assert.equal(safePattern(p, 200), undefined, p)
  })
})

describe('commandWords and pinsChanged', () => {
  const w = (c: string) => commandWords(c, '/home/sam').words
  test('splits on whitespace and shell punctuation, and expands ~ and $HOME', () => {
    assert.deepEqual(w('env ./x; if ./y; then $(./z) `./q` "$HOME/a" ~/b (./c)|./d >./e'),
      ['env', './x', 'if', './y', 'then', './z', './q', '/home/sam/a', '/home/sam/b', './c', './d', './e'])
    assert.deepEqual(w('node --require=./h ${HOME}/app.js ~'), ['node', '--require', './h', '/home/sam/app.js', '/home/sam'])
  })
  test('lists the word after each cd as a directory', () => {
    assert.deepEqual(commandWords('(cd /a; ./x) && cd ~ && sh -c "cd rel && ./y"', '/home/sam').cds, ['/a', '/home/sam', 'rel'])
  })
  test('lists a pin whose hash changed or whose file is gone, and nothing when all match', () => {
    const pins = { '/a': 'h1', '/b': 'h2', '/c': 'h3' }
    assert.deepEqual(pinsChanged(pins, { '/a': 'h1', '/b': 'zz', '/c': undefined }), ['/b', '/c'])
    assert.deepEqual(pinsChanged(pins, pins), [])
  })
})

describe('decide', () => {
  test('the first good run stores the fingerprint and text and does not wake', () => {
    const r = decide({ fails: 0 }, ok('v1\n'), probe, o)
    assert.equal(r.wake, undefined)
    assert.deepEqual(r.state, { fp: fpOf('v1'), last: 'v1', fails: 0 })
  })
  test('the same output again does nothing', () => {
    const s: JobState = { fp: fpOf('v1'), last: 'v1', fails: 0 }
    assert.deepEqual(decide(s, ok('v1'), probe, o), { state: s })
  })
  test('a changed output wakes with before and after, and stores the new text', () => {
    const r = decide({ fp: fpOf('v1'), last: 'v1', fails: 0 }, ok('v2'), probe, o)
    assert.deepEqual(r.wake, { before: 'v1', after: 'v2' })
    assert.equal(r.state.last, 'v2')
    assert.equal(r.state.fp, fpOf('v2'))
  })
  test('an ignored line changing does not wake', () => {
    const p = { ...probe, ignore: ['^ts='] }
    const first = decide({ fails: 0 }, ok('a\nts=1', p.ignore), p, o)
    assert.equal(decide(first.state, ok('a\nts=2', p.ignore), p, o).wake, undefined)
  })
  test('failures count up, ping once at failPing, never wake, and keep the stored fingerprint', () => {
    let s: JobState = { fp: 'f', last: 'v1', fails: 0 }
    const pings: (string | undefined)[] = []
    for (let i = 0; i < 5; i++) { const r = decide(s, bad, probe, o); s = r.state; pings.push(r.ping); assert.equal(r.wake, undefined) }
    assert.deepEqual(pings.map(Boolean), [false, false, true, false, false])
    assert.equal(s.fails, 5)
    assert.equal(s.fp, 'f')
  })
  test('a good run resets fails', () => {
    assert.equal(decide({ fp: fpOf('v1'), last: 'v1', fails: 2 }, ok('v1'), probe, o).state.fails, 0)
  })
  test('the failure ping carries the first line of stderr, capped', () => {
    const r = decide({ fails: 2 }, { ok: false, out: 'stdout line', fp: '', err: '\nboom: no route\nsecond' }, probe, o)
    assert.match(r.ping!, /boom: no route/)
    assert.doesNotMatch(r.ping!, /second|stdout line/)
    assert.ok(decide({ fails: 2 }, { ok: false, out: '', fp: '', err: 'e'.repeat(1000) }, probe, o).ping!.length < 400)
  })
  test('with no stderr the ping falls back to the first line of stdout', () => {
    assert.match(decide({ fails: 2 }, { ok: false, out: 'only out\nmore', fp: '' }, probe, o).ping!, /only out/)
  })
  test('stderr does not change the fingerprint, so a warning cannot wake', () => {
    const first = decide({ fails: 0 }, { ...ok('v1'), err: 'warn 1' }, probe, o)
    assert.equal(decide(first.state, { ...ok('v1'), err: 'warn 2' }, probe, o).wake, undefined)
  })
})
