import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { compareUrl, nextStep, soakGate } from '../auto-update.ts'

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


describe('soakGate: the candidate ran on the owner hub for 24 hours', () => {
  const H = 3_600_000
  const now = 1_800_000_000_000
  const ok = { candidate: 'abc1234def', running: 'abc1234', lastBootAt: now - 25 * H, crashDmAt: undefined, doctorOk: true, now }
  test('passes when the hub runs the commit, has been up 24 hours, doctor is all good and no crash DM', () => {
    assert.deepEqual(soakGate(ok), { ok: true })
  })
  test('fails when the hub runs another commit', () => {
    assert.deepEqual(soakGate({ ...ok, running: '1111111' }), { fail: 'the hub runs 1111111, not abc1234' })
  })
  test('fails when the hub started less than 24 hours ago', () => {
    assert.deepEqual(soakGate({ ...ok, lastBootAt: now - 23 * H }), { fail: 'the hub has run it for 23 hours, not 24' })
  })
  test('fails when no start time is known', () => {
    assert.deepEqual(soakGate({ ...ok, lastBootAt: undefined }), { fail: 'the hub start time is unknown' })
  })
  test('fails when a crash-loop DM went out in the last 24 hours', () => {
    assert.deepEqual(soakGate({ ...ok, crashDmAt: now - 2 * H }), { fail: 'a crash-loop DM went out 2 hours ago' })
    assert.deepEqual(soakGate({ ...ok, crashDmAt: now - 30 * H }), { ok: true })
  })
  test('fails when kage doctor is not all good', () => {
    assert.deepEqual(soakGate({ ...ok, doctorOk: false }), { fail: 'kage doctor is not "All good"' })
  })
})
