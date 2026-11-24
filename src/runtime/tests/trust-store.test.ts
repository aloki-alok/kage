import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openStore } from '../store.ts'
import { trustLinesIn } from '../trust-store.ts'

const fresh = () => {
  const path = join(mkdtempSync(join(tmpdir(), 'kage-trust-')), 'kage.db')
  return { path, store: openStore(path) }
}
const yes = { who: 'UTEAM0001', kind: 'prod-read', reach: 'db.example.test', answer: 'yes' as const, once: false, link: 'https://x/p' }

describe('the trust lines in the store', () => {
  test('a written line comes back live with an id, and survives a reopen', () => {
    const { path, store } = fresh()
    const id = store.addTrustLine(yes, 1_000)
    assert.match(id, /^T\d+$/)
    store.close()
    const again = openStore(path).trustLines()
    assert.deepEqual(again.map(l => [l.id, l.who, l.kind, l.reach, l.answer, l.once, l.state]), [[id, 'UTEAM0001', 'prod-read', 'db.example.test', 'yes', false, 'live']])
  })
  test('revoke ends a line, and an id that is not there changes nothing', () => {
    const { store } = fresh()
    const id = store.addTrustLine(yes, 1_000)
    assert.equal(store.revokeTrust('T99'), false)
    assert.equal(store.revokeTrust(id), true)
    assert.equal(store.revokeTrust(id), false)
    assert.deepEqual(store.trustLines().map(l => l.state), ['revoked'])
  })
  test('a terminal can read the lines without writing', () => {
    const { path, store } = fresh()
    store.addTrustLine(yes, 1_000)
    assert.equal(trustLinesIn(path).length, 1)
    assert.deepEqual(trustLinesIn(`${path}.missing`), [])
  })
})
