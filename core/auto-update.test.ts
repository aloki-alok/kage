import { test } from 'node:test'
import assert from 'node:assert/strict'
import { compareUrl, nextStep } from './auto-update.ts'

const clean = { git: true, branch: 'main', dirty: false }

test('a clean main checkout fetches first', () => {
  assert.equal(nextStep(clean), 'fetch')
})

test('behind origin and not ahead pulls', () => {
  assert.equal(nextStep({ ...clean, ahead: 0, behind: 3 }), 'pull')
})

test('level with origin does nothing', () => {
  assert.equal(nextStep({ ...clean, ahead: 0, behind: 0 }), 'current')
})

test('a local commit the remote lacks is never pulled over', () => {
  assert.deepEqual(nextStep({ ...clean, ahead: 1, behind: 0 }), { skip: 'main has 1 local commit that origin/main lacks' })
  assert.deepEqual(nextStep({ ...clean, ahead: 2, behind: 5 }), { skip: 'main has 2 local commits that origin/main lacks' })
})

test('every other checkout is left alone, with the reason', () => {
  assert.deepEqual(nextStep({ git: false }), { skip: 'not a git checkout' })
  assert.deepEqual(nextStep({ ...clean, branch: 'my-fix' }), { skip: 'on branch my-fix, not main' })
  assert.deepEqual(nextStep({ ...clean, dirty: true }), { skip: 'the checkout has uncommitted changes' })
  assert.deepEqual(nextStep({ ...clean, fetchError: 'could not resolve host' }), { skip: 'git fetch failed: could not resolve host' })
})

test('the compare link comes from the origin url, https or ssh', () => {
  assert.equal(compareUrl('https://github.com/acme/kage.git', 'aaa1111', 'bbb2222'), 'https://github.com/acme/kage/compare/aaa1111...bbb2222')
  assert.equal(compareUrl('git@github.com:acme/kage.git', 'aaa1111', 'bbb2222'), 'https://github.com/acme/kage/compare/aaa1111...bbb2222')
  assert.equal(compareUrl('https://github.com/acme/kage', 'aaa1111', 'bbb2222'), 'https://github.com/acme/kage/compare/aaa1111...bbb2222')
  assert.equal(compareUrl('https://gitlab.example.com/acme/kage.git', 'aaa1111', 'bbb2222'), undefined)
})
