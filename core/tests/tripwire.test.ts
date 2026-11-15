import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { decide, fingerprint, normalize, pinsChanged, safePattern, scriptPaths, type JobState, type Probe } from '../tripwire.ts'

const probe: Probe = { command: 'x', pins: {}, ignore: [] }
const o = { failPing: 3, lineMax: 2000 }
const ok = (out: string) => ({ ok: true, out })
const bad = { ok: false, out: '' }

describe('normalize and fingerprint', () => {
  test('drops lines matching an ignore regex and trims trailing space', () => {
    assert.equal(normalize('a  \nts=12\nb\t', ['^ts='], 2000), 'a\nb')
  })
  test('a regex sees only the first lineMax characters of a line', () => {
    const line = 'a'.repeat(20) + 'z'
    assert.equal(normalize(line, ['z$'], 2000), '')
    assert.equal(normalize(line, ['z$'], 10), line)
  })
  test('the same text gives the same sha256 hex, and different text a different one', () => {
    assert.match(fingerprint('a'), /^[0-9a-f]{64}$/)
    assert.equal(fingerprint('a'), fingerprint('a'))
    assert.notEqual(fingerprint('a'), fingerprint('b'))
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

describe('scriptPaths and pinsChanged', () => {
  const sp = (c: string, interp?: string[]) => scriptPaths(c, '/home/sam', '/work', interp)
  test('a command segment head that is a path runs, with ~ expanded and ./ resolved against the cwd', () => {
    assert.deepEqual(sp('~/bin/check.sh --flag; ./local.sh'), ['/home/sam/bin/check.sh', '/work/local.sh'])
  })
  test('a data file argument is not a script', () => {
    assert.deepEqual(sp('wc -l /var/log/app.log | grep x /tmp/y'), [])
  })
  test('the first non-flag argument after an interpreter is a script, with or without ./', () => {
    assert.deepEqual(sp('python3 check.py a.txt'), ['/work/check.py'])
    assert.deepEqual(sp('/bin/sh -e ./x.sh'), ['/bin/sh', '/work/x.sh'])
    assert.deepEqual(sp('ruby a.rb', ['sh']), [])
  })
  test('cd moves later relative paths, and segments split on && || | ; and newlines', () => {
    assert.deepEqual(sp('cd /opt/x && ./run.sh || ./b.sh\n./c.sh | ./d.sh'), ['/opt/x/run.sh', '/opt/x/b.sh', '/opt/x/c.sh', '/opt/x/d.sh'])
  })
  test('quotes around a word are dropped', () => {
    assert.deepEqual(sp(`"/a/b.sh" 'x'`), ['/a/b.sh'])
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
    assert.deepEqual(r.state, { fp: fingerprint('v1'), last: 'v1', fails: 0 })
  })
  test('the same output again does nothing', () => {
    const s: JobState = { fp: fingerprint('v1'), last: 'v1', fails: 0 }
    assert.deepEqual(decide(s, ok('v1'), probe, o), { state: s })
  })
  test('a changed output wakes with before and after, and stores the new text', () => {
    const r = decide({ fp: fingerprint('v1'), last: 'v1', fails: 0 }, ok('v2'), probe, o)
    assert.deepEqual(r.wake, { before: 'v1', after: 'v2' })
    assert.equal(r.state.last, 'v2')
    assert.equal(r.state.fp, fingerprint('v2'))
  })
  test('an ignored line changing does not wake', () => {
    const p = { ...probe, ignore: ['^ts='] }
    const first = decide({ fails: 0 }, ok('a\nts=1'), p, o)
    assert.equal(decide(first.state, ok('a\nts=2'), p, o).wake, undefined)
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
    assert.equal(decide({ fp: fingerprint('v1'), last: 'v1', fails: 2 }, ok('v1'), probe, o).state.fails, 0)
  })
  test('the failure ping carries the first line of stderr, capped', () => {
    const r = decide({ fails: 2 }, { ok: false, out: 'stdout line', err: '\nboom: no route\nsecond' }, probe, o)
    assert.match(r.ping!, /boom: no route/)
    assert.doesNotMatch(r.ping!, /second|stdout line/)
    assert.ok(decide({ fails: 2 }, { ok: false, out: '', err: 'e'.repeat(1000) }, probe, o).ping!.length < 400)
  })
  test('with no stderr the ping falls back to the first line of stdout', () => {
    assert.match(decide({ fails: 2 }, { ok: false, out: 'only out\nmore' }, probe, o).ping!, /only out/)
  })
  test('stderr does not change the fingerprint, so a warning cannot wake', () => {
    const first = decide({ fails: 0 }, { ok: true, out: 'v1', err: 'warn 1' }, probe, o)
    assert.equal(decide(first.state, { ok: true, out: 'v1', err: 'warn 2' }, probe, o).wake, undefined)
  })
})
