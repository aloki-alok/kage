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
  test('a proposal is not live, and the same source never proposes twice', () => {
    const { store } = fresh()
    assert.equal(store.proposeTrust({ ...yes, source: 'relay_allow:C1:5.5' }, 1_000), true)
    assert.equal(store.proposeTrust({ ...yes, source: 'relay_allow:C1:5.5' }, 2_000), false)
    assert.deepEqual(store.trustLines().map(l => l.state), ['proposed'])
  })
  test('confirm makes a proposal live, and a confirmed line is not proposed again after a revoke', () => {
    const { store } = fresh()
    store.proposeTrust({ ...yes, source: 's1' }, 1_000)
    assert.equal(store.confirmTrust('all'), 1)
    assert.deepEqual(store.trustLines().map(l => l.state), ['live'])
    const [line] = store.trustLines()
    assert.equal(store.revokeTrust(line!.id), true)
    assert.equal(store.proposeTrust({ ...yes, source: 's1' }, 3_000), false)
    assert.deepEqual(store.trustLines().map(l => l.state), ['revoked'])
  })
  test('confirm and revoke of an id that is not there change nothing', () => {
    const { store } = fresh()
    assert.equal(store.confirmTrust('T99'), 0)
    assert.equal(store.revokeTrust('T99'), false)
  })
  test('a terminal can read the lines without writing', () => {
    const { path, store } = fresh()
    store.addTrustLine(yes, 1_000)
    assert.equal(trustLinesIn(path).length, 1)
    assert.deepEqual(trustLinesIn(`${path}.missing`), [])
  })
})
