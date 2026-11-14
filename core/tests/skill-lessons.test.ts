import { test } from 'node:test'
import assert from 'node:assert/strict'
import { wordingProblems } from '../skill-lessons.ts'
import { dreamTask } from '../dream.ts'

test('a generic lesson passes, and each kind of private detail is named', () => {
  assert.deepEqual(wordingProblems('Read the file before you answer, because a guess costs a correction.', ['Asha']), [])
  assert.match(wordingProblems('Asha asked twice', ['Asha']).join(), /name/)
  assert.match(wordingProblems('ask <@U0TEST1A2B> first', []).join(), /id/)
  assert.match(wordingProblems('it broke on 2026-11-05', []).join(), /date/)
  assert.match(wordingProblems('the owner said "so longgg"', []).join(), /quote/)
  assert.match(wordingProblems('mail a@b.com or open /Users/x/notes', []).join(), /email|path/)
})
test('a name inside a longer word is not a name', () => {
  assert.deepEqual(wordingProblems('Ashamed is not Asha', ['Asha']).length, 1)
  assert.deepEqual(wordingProblems('Ashamed users leave', ['Asha']), [])
})

const m = { own: '/m/kage', owner: '/m/owner' }
test('the dream proposes a generic lesson as a PR only on the repo owner\'s hub, and never merges it', () => {
  const on = dreamTask(m, [], 'T', { dir: '/r/skills', pr: true })
  assert.match(on, /\/r\/skills/)
  assert.match(on, /gh pr create/)
  assert.match(on, /never merge/i)
  assert.match(on, /skill-lesson/)
})
test('on any other install a generic lesson stays in local memory', () => {
  const off = dreamTask(m, [], 'T', { dir: '/r/skills', pr: false })
  assert.doesNotMatch(off, /gh pr create/)
  assert.match(off, /only in .*memory/i)
})
test('without a skills folder the dream is the one it was', () => {
  assert.equal(dreamTask(m, [], 'T'), dreamTask(m, [], 'T', undefined))
  assert.doesNotMatch(dreamTask(m, [], 'T'), /skill/i)
})
