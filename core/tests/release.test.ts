import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { bumpVersion, releasePlan } from '../release.ts'

describe('bumpVersion', () => {
  test('minor resets the patch, patch adds one', () => {
    assert.equal(bumpVersion('0.3.0', 'minor'), '0.4.0')
    assert.equal(bumpVersion('0.3.7', 'minor'), '0.4.0')
    assert.equal(bumpVersion('0.3.7', 'patch'), '0.3.8')
  })
  test('a version that is not x.y.z is refused', () => {
    assert.throws(() => bumpVersion('0.3', 'patch'))
  })
})

describe('releasePlan', () => {
  test('a new feature makes a minor release, grouped with fixes and other work', () => {
    const p = releasePlan('0.3.0', ['Add kage release (#150)', 'Fix a stuck thread (#151)', 'One webhook helper (#145)'])!
    assert.equal(p.version, '0.4.0')
    assert.equal(p.notes, '## New\n- Add kage release (#150)\n\n## Fixed\n- Fix a stuck thread (#151)\n\n## Other\n- One webhook helper (#145)')
  })
  test('with no new feature it is a patch', () => {
    assert.equal(releasePlan('0.3.0', ['Fix a stuck thread (#151)'])!.version, '0.3.1')
  })
  test('internal-only changes are left out of the notes but still make a patch', () => {
    const p = releasePlan('0.3.0', ['Add ADRs and a kage-change-code skill (#138)', 'Docs: settings table (#139)', 'Fix a stuck thread (#151)'])!
    assert.equal(p.notes, '## Fixed\n- Fix a stuck thread (#151)')
    const only = releasePlan('0.3.0', ['Add ADRs and a skill (#138)'])!
    assert.equal(only.version, '0.3.1')
    assert.equal(only.notes, 'Internal changes only.')
  })
  test('a refusal or a stop counts as a fix, not a new feature', () => {
    const p = releasePlan('0.3.0', ['WhatsApp webhook: refuse unsigned callers before reading the body (#141)'])!
    assert.equal(p.version, '0.3.1')
    assert.match(p.notes, /## Fixed/)
  })
  test('merge commits and dependency bumps are internal', () => {
    const p = releasePlan('0.3.0', ['Merge pull request #131 from acme/kage-x', 'Bump the all group with 7 updates (#61)', 'Fix a stuck thread (#151)'])!
    assert.equal(p.notes, '## Fixed\n- Fix a stuck thread (#151)')
  })
  test('no merges gives no release', () => {
    assert.equal(releasePlan('0.3.0', []), undefined)
  })
})
