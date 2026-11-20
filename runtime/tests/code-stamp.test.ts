import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { codeStamp } from '../code-stamp.ts'

const FILES = ['hub/router.ts', 'core/gate.ts', 'connectors/slack/connect.ts', 'runtime/store.ts', 'core/gate.test.ts', 'package-lock.json']
const tree = () => {
  const root = mkdtempSync(join(tmpdir(), 'kage-stamp-'))
  for (const d of ['hub', 'core', 'connectors', 'connectors/slack', 'runtime']) mkdirSync(join(root, d))
  for (const f of FILES) { writeFileSync(join(root, f), ''); utimesSync(join(root, f), 1000, 1000) }
  return root
}

for (const f of ['hub/router.ts', 'core/gate.ts', 'connectors/slack/connect.ts', 'runtime/store.ts']) test(`a change to ${f} moves the stamp, so a merge restarts the hub`, () => {
  const root = tree()
  const before = codeStamp(root)
  utimesSync(join(root, f), 2000, 2000)
  assert.ok(codeStamp(root) > before)
})

test('new packages move the stamp too', () => {
  const root = tree()
  const before = codeStamp(root)
  utimesSync(join(root, 'package-lock.json'), 2000, 2000)
  assert.ok(codeStamp(root) > before)
})

test('editing a test does not restart the hub', () => {
  const root = tree()
  const before = codeStamp(root)
  utimesSync(join(root, 'core', 'gate.test.ts'), 2000, 2000)
  assert.equal(codeStamp(root), before)
})

test('a change one folder down, as runtime/tools/ or connectors/slack/, moves the stamp, and a test there does not', () => {
  const root = tree()
  for (const d of ['runtime/tools', 'connectors/slack/tests']) mkdirSync(join(root, d))
  for (const f of ['runtime/tools/slack-tools.ts', 'connectors/slack/tests/connect.test.ts']) { writeFileSync(join(root, f), ''); utimesSync(join(root, f), 1000, 1000) }
  const before = codeStamp(root)
  utimesSync(join(root, 'connectors/slack/tests/connect.test.ts'), 3000, 3000)
  assert.equal(codeStamp(root), before)
  for (const f of ['runtime/tools/slack-tools.ts', 'connectors/slack/connect.ts']) {
    const was = codeStamp(root)
    utimesSync(join(root, f), was / 1000 + 10, was / 1000 + 10)
    assert.ok(codeStamp(root) > was, f)
  }
})
