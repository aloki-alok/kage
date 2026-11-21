import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { commandWords, decide, eventNeedsCard, triggerLine, hookTokenHash, lineHasher, normalize, pinsChanged, safePattern, type JobState, type Probe } from '../tripwire.ts'

const probe: Probe = { command: 'x', pins: {}, ignore: [], reads: [], writes: [] }
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
  test('a long line cut across chunks hashes the same as whole, trailing spaces trimmed', () => {
    const text = 'x\n' + 'ab '.repeat(10) + '  \t\n\ny'
    const want = sha(normalize(text, [], 8))
    assert.equal(hashed([text], [], 8), want)
    assert.equal(hashed(text.split(''), [], 8), want)
    assert.equal(hashed(['x\nab ab', ' ab ab ab ab ab ab ab ab   ', '\t\n', '\ny'], [], 8), want)
  })
  test('any text cut at random points hashes like the whole normalized text', () => {
    const bits = ['a', 'b', ' ', '\t', '\n', '\n\n', 'ts=1', 'xxxxxxxxxxxx', '   \n']
    for (let n = 0; n < 300; n++) {
      let text = ''
      for (let i = 0; i < 40; i++) text += bits[Math.floor(Math.random() * bits.length)]
      const cuts: string[] = []
      for (let at = 0; at < text.length;) { const len = 1 + Math.floor(Math.random() * 12); cuts.push(text.slice(at, at + len)); at += len }
      assert.equal(hashed(cuts, ['^ts='], 8), sha(normalize(text, ['^ts='], 8)), JSON.stringify(cuts))
    }
  })
  test('a huge line with no newline streams in linear time', () => {
    const chunk = 'a'.repeat(65536), t = Date.now()
    const h = lineHasher([], 2000)
    for (let i = 0; i < 1280; i++) h.push(chunk)
    assert.match(h.end(), /^[0-9a-f]{64}$/)
    assert.ok(Date.now() - t < 3000, `took ${Date.now() - t} ms`)
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
  test('lists the file words after >, >>, 2>, &> and tee as outputs, and not 2>&1', () => {
    const outs = (c: string) => commandWords(c, '/home/sam').outs
    assert.deepEqual(outs('curl u > /tmp/out.json; x >> log; y 2> e; z &> "a b"; w >~/h'), ['/tmp/out.json', 'log', 'e', 'a', '/home/sam/h'])
    assert.deepEqual(outs('x | tee f; y | tee -a g h | cat'), ['f', 'g', 'h'])
    assert.deepEqual(outs('x 2>&1; y >&2; a < in'), [])
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
  test('a verdict line saying wake false keeps a changed output quiet (#516)', () => {
    const r = decide({ fp: fpOf('v1'), last: 'v1', fails: 0 }, ok('v2\n{"wake": false}'), probe, o)
    assert.equal(r.wake, undefined)
    assert.equal(r.state.fp, fpOf('v2\n{"wake": false}'))
  })
  test('a verdict line saying wake true wakes on the same output, and the wake carries only its context (#516)', () => {
    const out = 'v1\n{"wake": true, "context": {"replies": 2}}'
    const s: JobState = { fp: fpOf(out), last: out, fails: 0 }
    assert.deepEqual(decide(s, ok(out), probe, o).wake, { context: '{"replies":2}' })
    assert.deepEqual(decide({ fails: 0 }, ok(out), probe, o).wake, { context: '{"replies":2}' })
  })
  test('a last line that is not a valid verdict falls back to the change rule (#516)', () => {
    for (const line of ['{"wake": "yes"}', '{"wake": true', '{"wake": true, "context": "x"}', '[true]']) {
      const s: JobState = { fp: fpOf(`v1\n${line}`), last: `v1\n${line}`, fails: 0 }
      assert.equal(decide(s, ok(`v1\n${line}`), probe, o).wake, undefined, line)
      assert.ok(decide(s, ok(`v2\n${line}`), probe, o).wake?.after, line)
    }
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
  test('a refused run pings at once, naming the path and the fix, and pings again only for a new refusal', () => {
    const refused = (why: string) => ({ ok: false, out: '', fp: '', refused: why })
    const r1 = decide({ fails: 0 }, refused('changed or missing: /opt/x.sh'), probe, o)
    assert.match(r1.ping!, /\/opt\/x\.sh/)
    assert.match(r1.ping!, /reads.*writes.*approve/)
    assert.equal(r1.wake, undefined)
    assert.equal(decide(r1.state, refused('changed or missing: /opt/x.sh'), probe, o).ping, undefined)
    assert.match(decide(r1.state, refused('changed or missing: /opt/y.sh'), probe, o).ping!, /y\.sh/)
    const good = decide(r1.state, ok('v1'), probe, o)
    assert.equal(good.state.refused, undefined)
    assert.match(decide(good.state, refused('changed or missing: /opt/x.sh'), probe, o).ping!, /x\.sh/)
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

describe('webhook jobs', () => {
  test('only the sha256 of a token is kept', () => {
    assert.equal(hookTokenHash('t0k'), sha('t0k'))
  })
  test('a teammate or agent asking for a hook or a channel watch needs the owner card, the owner does not, and a plain schedule never does', () => {
    assert.equal(eventNeedsCard('mcp__kage__schedule', { hook: true }, 'teammate'), true)
    assert.equal(eventNeedsCard('mcp__kage__schedule', { hook: true }, 'owner'), false)
    assert.equal(eventNeedsCard('mcp__kage__schedule', { cron: '* * * * *' }, 'teammate'), false)
    assert.equal(eventNeedsCard('mcp__kage__schedule', { on_channel: { channel: 'CTEST9' } }, 'teammate'), true)
    assert.equal(eventNeedsCard('mcp__kage__schedule', { on_channel: { channel: 'CTEST9' } }, 'owner'), false)
    assert.equal(eventNeedsCard('mcp__kage__reply', { hook: true }, 'teammate'), false)
  })
})

describe('a job trigger in one line, for kage schedules', () => {
  test('each kind names what wakes the job', () => {
    const probe: Probe = { command: 'check.sh | grep TOTAL=', pins: {}, ignore: [], reads: [], writes: [] }
    assert.equal(triggerLine({ kind: 'probe', probe }), 'probe: check.sh | grep TOTAL=')
    assert.equal(triggerLine({ kind: 'channel', channel: 'CTEST1', match: 'fatal|error', bots: true }), 'watches CTEST1 for /fatal|error/, bots too')
    assert.equal(triggerLine({ kind: 'channel', channel: 'CTEST1', bots: false }), 'watches CTEST1, every post by a person')
    assert.equal(triggerLine({ kind: 'hook', tokenHash: 'abc' }), 'webhook')
  })
})
