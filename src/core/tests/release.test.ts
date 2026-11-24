import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { bumpVersion, checkProblems, releasePlan } from '../release.ts'

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
  const UPGRADING = '## Upgrading\nRun kage update --stable, or wait: a git install on main moves to this release within 6 hours.'
  test('a new feature makes a minor release, with each title in its section and its type and scope taken off', () => {
    const p = releasePlan('0.3.0', ['feat(src/hub/self-check): a failure that repeats reaches the owner (#680)', 'fix(src/core/quiet): kage restart cuts nothing when the hub is slow (#679)', 'ci: run kage-screen only for screen changes (#678)'])!
    assert.equal(p.version, '0.4.0')
    assert.equal(p.notes, `## New features\n- a failure that repeats reaches the owner (#680)\n\n## Bug fixes\n- kage restart cuts nothing when the hub is slow (#679)\n\n## Under the hood\n- run kage-screen only for screen changes (#678)\n\n${UPGRADING}`)
  })
  test('the six sections come in a fixed order, and a title with no type reads as a feature', () => {
    const p = releasePlan('0.3.0', ['refactor: one webhook helper (#5)', 'Fix a stuck thread (#4)', 'perf: kage top draws faster (#3)', 'Trust record: Kage remembers each yes per teammate (#2)', 'Add kage cost (#1)', 'Each daily note leaves one line in kage logs (#6)'])!
    assert.equal(p.version, '0.4.0')
    assert.equal(p.notes, `## New features\n- Add kage cost (#1)\n- Each daily note leaves one line in kage logs (#6)\n\n## Access and safety\n- Trust record: Kage remembers each yes per teammate (#2)\n\n## Optimizations\n- kage top draws faster (#3)\n\n## Bug fixes\n- Fix a stuck thread (#4)\n\n## Under the hood\n- one webhook helper (#5)\n\n${UPGRADING}`)
  })
  test('the type wins over the words: a feat that says --fix is a feature, and moves and splits are internal and a patch', () => {
    const p = releasePlan('0.3.0', ['feat(src/cli/doctor): kage doctor --fix heals what touches only Kage files (#650)', 'Move four start-up blocks out of the hub router (#9)'])!
    assert.equal(p.version, '0.4.0')
    assert.match(p.notes, /^## New features\n- kage doctor --fix heals what touches only Kage files \(#650\)\n\n## Under the hood\n- Move four start-up blocks/)
    assert.equal(releasePlan('0.3.0', ['Split the meetbot attend loop (#8)', 'Drop a call that did nothing (#7)'])!.version, '0.3.1')
    assert.match(releasePlan('0.3.0', ['kage doctor --fix runs hourly (#7)'])!.notes, /^## New features/)
  })
  test('with no new feature it is a patch', () => {
    assert.equal(releasePlan('0.3.0', ['Fix a stuck thread (#151)'])!.version, '0.3.1')
    assert.equal(releasePlan('0.3.0', ['fix(src/a): a stuck thread (#151)', 'docs: settings table (#139)'])!.version, '0.3.1')
  })
  test('a refusal is a safety change and a patch', () => {
    const p = releasePlan('0.3.0', ['WhatsApp webhook: refuse unsigned callers before reading the body (#141)'])!
    assert.equal(p.version, '0.3.1')
    assert.match(p.notes, /^## Access and safety\n- WhatsApp webhook: refuse unsigned callers/)
  })
  test('merge commits, dependency bumps, docs and release commits sit under the hood and make a patch', () => {
    const p = releasePlan('0.3.0', ['Merge pull request #131 from acme/kage-x', 'Bump the all group with 7 updates (#61)', 'Add ADRs and a skill (#138)', 'Release v0.3.0'])!
    assert.equal(p.version, '0.3.1')
    assert.match(p.notes, /^## Under the hood\n- Merge pull request #131 from acme\/kage-x\n- Bump the all group with 7 updates \(#61\)\n- Add ADRs and a skill \(#138\)\n- Release v0\.3\.0\n\n## Upgrading/)
  })
  test('a new feature that mentions skills, docs or bugs is still new', () => {
    assert.equal(releasePlan('0.3.0', ['Add skills to kagelets (#1)'])!.version, '0.4.0')
    assert.equal(releasePlan('0.3.0', ['Add a bug report command (#2)'])!.version, '0.4.0')
  })
  test('no merges gives no release', () => {
    assert.equal(releasePlan('0.3.0', []), undefined)
  })
})

describe('checkProblems', () => {
  const sha = 'abcdef1234567'
  test('a candidate is released only when both its tests and its upgrade drill passed on that commit (#312)', () => {
    assert.deepEqual(checkProblems(sha, { 'ci.yml': 'completed success', 'upgrade.yml': 'completed success' }), [])
    assert.deepEqual(checkProblems(sha, { 'ci.yml': 'completed success', 'upgrade.yml': 'completed failure' }), ['upgrade.yml on abcdef1 is not green (completed failure)'])
    assert.deepEqual(checkProblems(sha, { 'ci.yml': 'completed success', 'upgrade.yml': 'in_progress ' }), ['upgrade.yml on abcdef1 is not green (in_progress )'])
    assert.deepEqual(checkProblems(sha, { 'upgrade.yml': 'completed success' }), ['ci.yml on abcdef1 is not green (no run found)'])
    assert.deepEqual(checkProblems(sha, {}), ['ci.yml on abcdef1 is not green (no run found)', 'upgrade.yml on abcdef1 is not green (no run found)'])
  })
})
