import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { linkToken, ownerKey, readOwnerKey, sameSecret } from '../owner-key.ts'

test('the hub makes one random owner key, mode 600, keeps it across starts, and the kage command reads it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kage-okey-'))
  assert.equal(readOwnerKey(dir), '')
  const { key, made } = ownerKey(dir)
  assert.match(key, /^[0-9a-f]{64}$/)
  assert.equal(made, true)
  assert.equal(statSync(join(dir, 'owner.key')).mode & 0o777, 0o600)
  assert.deepEqual(ownerKey(dir), { key, made: false })
  assert.equal(readOwnerKey(dir), key)
  assert.notEqual(ownerKey(mkdtempSync(join(tmpdir(), 'kage-okey-'))).key, key)
})

test('a damaged key file is replaced, never trusted', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kage-okey-'))
  writeFileSync(join(dir, 'owner.key'), 'xyz', { mode: 0o600 })
  assert.equal(readOwnerKey(dir), '')
  const { key, made } = ownerKey(dir)
  assert.match(key, /^[0-9a-f]{64}$/)
  assert.equal(made, true)
  assert.equal(readFileSync(join(dir, 'owner.key'), 'utf8'), key)
})

test("a thread's link token is its own: another thread or another key gives another token", () => {
  const a = 'a1'.repeat(32), b = 'b2'.repeat(32)
  assert.equal(linkToken(a, 'C1:5.5'), linkToken(a, 'C1:5.5'))
  assert.notEqual(linkToken(a, 'C1:5.5'), linkToken(a, 'C1:6.6'))
  assert.notEqual(linkToken(a, 'C1:5.5'), linkToken(b, 'C1:5.5'))
})

test('a secret matches only the same string, and an empty want matches nothing', () => {
  assert.equal(sameSecret('abc', 'abc'), true)
  for (const given of ['abd', 'ab', 'abcd', '', undefined, 7, null]) assert.equal(sameSecret(given, 'abc'), false, String(given))
  assert.equal(sameSecret('', ''), false)
})
