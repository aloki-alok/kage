import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { compareUrl, inertChange, nextStep, soakGate, type Boot } from '../auto-update.ts'

const clean = { git: true, branch: 'main', dirty: false }

test('a clean main checkout fetches first', () => {
  assert.equal(nextStep(clean), 'fetch')
})

test('no stable tag on origin: no update, with the reason', () => {
  assert.deepEqual(nextStep({ ...clean, stable: false }), { skip: 'origin has no stable tag yet' })
  assert.deepEqual(nextStep({ ...clean, stable: false, ahead: 0, behind: 3 }), { skip: 'origin has no stable tag yet' })
})

test('behind the stable tag and not ahead pulls', () => {
  assert.equal(nextStep({ ...clean, ahead: 0, behind: 3 }), 'pull')
})

test('level with origin does nothing', () => {
  assert.equal(nextStep({ ...clean, ahead: 0, behind: 0 }), 'current')
})

test('a commit the stable tag lacks is never pulled over', () => {
  assert.deepEqual(nextStep({ ...clean, ahead: 1, behind: 0 }), { skip: 'main has 1 commit that the stable tag lacks' })
  assert.deepEqual(nextStep({ ...clean, ahead: 2, behind: 5 }), { skip: 'main has 2 commits that the stable tag lacks' })
})

test('every other checkout is left alone, with the reason', () => {
  assert.deepEqual(nextStep({ git: false }), { skip: 'not a git checkout' })
  assert.deepEqual(nextStep({ ...clean, branch: 'my-fix' }), { skip: 'on branch my-fix, not main' })
  assert.deepEqual(nextStep({ ...clean, dirty: true }), { skip: 'the checkout has uncommitted changes' })
  assert.deepEqual(nextStep({ ...clean, fetchError: 'could not resolve host' }), { skip: 'could not reach origin: could not resolve host' })
})

test('the compare link comes from the origin url, https or ssh', () => {
  assert.equal(compareUrl('https://github.com/acme/kage.git', 'aaa1111', 'bbb2222'), 'https://github.com/acme/kage/compare/aaa1111...bbb2222')
  assert.equal(compareUrl('git@github.com:acme/kage.git', 'aaa1111', 'bbb2222'), 'https://github.com/acme/kage/compare/aaa1111...bbb2222')
  assert.equal(compareUrl('https://github.com/acme/kage', 'aaa1111', 'bbb2222'), 'https://github.com/acme/kage/compare/aaa1111...bbb2222')
  assert.equal(compareUrl('https://gitlab.example.com/acme/kage.git', 'aaa1111', 'bbb2222'), undefined)
})


describe('inertChange: a diff that touches nothing the hub runs', () => {
  const f = (path: string, versionOnly?: boolean) => ({ path, versionOnly })
  test('docs, tests, skill text and licenses are inert, and so is no diff at all', () => {
    assert.equal(inertChange([]), true)
    assert.equal(inertChange([f('README.md'), f('docs/adr/0001.md'), f('core/tests/x.test.ts'), f('.claude/skills/a/SKILL.md'), f('skills/b/notes.txt'), f('LICENSE-MIT')]), true)
  })
  test('code is not inert, even beside docs', () => {
    assert.equal(inertChange([f('README.md'), f('core/gate.ts')]), false)
    assert.equal(inertChange([f('skills/run.sh')]), false)
    assert.equal(inertChange([f('LICENSE.ts')]), false)
    assert.equal(inertChange([f('docs/build.ts')]), false)
  })
  test('the version files are inert only when the version is all that changed', () => {
    assert.equal(inertChange([f('package.json', true), f('package-lock.json', true), f('.claude-plugin/plugin.json', true)]), true)
    assert.equal(inertChange([f('package.json', false)]), false)
    assert.equal(inertChange([f('package.json')]), false)
  })
})

describe('soakGate: release the newest commit that completed an unbroken 24 hours on the owner hub', () => {
  const H = 3_600_000
  const t0 = Date.parse('2026-11-15T00:00:00Z')
  const at = (h: number) => t0 + h * H
  const boot = (h: number, sha: string, inert = false): Boot => ({ at: at(h), sha, inert })
  const gate = (boots: Boot[], h: number, o: { crashes?: number[]; doctorOk?: boolean; ahead?: (sha: string) => boolean } = {}) =>
    soakGate({ boots, crashes: o.crashes ?? [], now: at(h), doctorOk: o.doctorOk ?? true, ahead: o.ahead ?? (() => true) })
  const A = 'aaa1111', B = 'bbb2222'

  test('boot on A, restart on A at 10 hours: the gate passes at 24 hours', () => {
    const boots = [boot(0, A), boot(10, A)]
    assert.deepEqual(gate(boots, 24), { ok: true, sha: A })
    assert.ok('fail' in gate(boots, 23))
  })
  test('a docs-only commit at 10 hours does not reset the clock, and the newer commit is the candidate', () => {
    assert.deepEqual(gate([boot(0, A), boot(10, B, true)], 24), { ok: true, sha: B })
  })
  test('a code commit at 20 hours resets the clock, and A, which ran 20 hours, is not releasable', () => {
    const r = gate([boot(0, A), boot(20, B)], 24)
    assert.deepEqual(r, { fail: `the next release candidate is ${B}, its gate opens ${new Date(at(44)).toISOString()}`, sha: B, opensAt: at(44) })
  })
  test('A soaked 24 hours and then B landed: release A', () => {
    assert.deepEqual(gate([boot(0, A), boot(30, B)], 31), { ok: true, sha: A })
  })
  test('a commit already released is skipped, so the next run is the candidate', () => {
    const r = gate([boot(0, A), boot(30, B)], 31, { ahead: sha => sha !== A })
    assert.ok('fail' in r && r.sha === B && r.opensAt === at(54))
  })
  test('a crash-loop DM inside a run voids that run, and the clock restarts at the crash', () => {
    const boots = [boot(0, A)]
    assert.ok('fail' in gate(boots, 25, { crashes: [at(15)] }))
    assert.deepEqual(gate(boots, 40, { crashes: [at(15)] }), { ok: true, sha: A })
  })
  test('three boots inside ten minutes count as a crash loop with no DM record', () => {
    const m = 60_000
    const boots = [{ at: at(0), sha: A, inert: false }, { at: at(0) + 2 * m, sha: A, inert: false }, { at: at(0) + 4 * m, sha: A, inert: false }]
    assert.ok('fail' in soakGate({ boots, crashes: [], now: at(24), doctorOk: true, ahead: () => true }))
    assert.deepEqual(soakGate({ boots, crashes: [], now: at(0) + 4 * m + 24 * H, doctorOk: true, ahead: () => true }), { ok: true, sha: A })
  })
  test('a crash after a completed run does not take that run back', () => {
    assert.deepEqual(gate([boot(0, A), boot(30, B)], 40, { crashes: [at(35)] }), { ok: true, sha: A })
  })
  test('kage doctor not all good, and no boots at all, both wait', () => {
    assert.deepEqual(gate([boot(0, A)], 25, { doctorOk: false }), { fail: 'kage doctor is not "All good"', sha: A })
    assert.deepEqual(gate([], 25), { fail: 'no hub start is recorded yet' })
  })
})
