import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { decide, fingerprint, normalize, pinsChanged, scriptPaths, type JobState, type Probe } from '../tripwire.ts'

const probe: Probe = { command: 'x', pins: {}, ignore: [] }
const o = { failPing: 3 }
const ok = (out: string) => ({ ok: true, out })
const bad = { ok: false, out: '' }

describe('normalize and fingerprint', () => {
  test('drops lines matching an ignore regex and trims trailing space', () => {
    assert.equal(normalize('a  \nts=12\nb\t', ['^ts=']), 'a\nb')
  })
  test('the same text gives the same sha256 hex, and different text a different one', () => {
    assert.match(fingerprint('a'), /^[0-9a-f]{64}$/)
    assert.equal(fingerprint('a'), fingerprint('a'))
    assert.notEqual(fingerprint('a'), fingerprint('b'))
  })
})

describe('scriptPaths and pinsChanged', () => {
  test('finds words that start with / ~/ or ./ and expands ~', () => {
    assert.deepEqual(scriptPaths('/bin/sh ~/bin/check.sh ./local.py --flag=1 plain', '/home/sam'), ['/bin/sh', '/home/sam/bin/check.sh', './local.py'])
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
  test('shadowUntil is kept', () => {
    assert.equal(decide({ fails: 0, shadowUntil: 99 }, ok('v1'), probe, o).state.shadowUntil, 99)
  })
})
