import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { typeKeys, pickSecret, shownAs, SECRETS } from '../secret-prompt.ts'

describe('typeKeys: what a hidden prompt holds after each key', () => {
  test('characters add, backspace removes, Enter ends', () => {
    assert.deepEqual(typeKeys({ typed: '' }, 'abx\u007fc\r'), { typed: 'abc', end: 'enter' })
    assert.deepEqual(typeKeys({ typed: 'ab' }, '\b'), { typed: 'a' })
  })
  test('a paste arrives in one chunk and keeps going', () => {
    assert.deepEqual(typeKeys({ typed: '' }, 'xoxp-1-2'), { typed: 'xoxp-1-2' })
  })
  test('arrow keys and other escape sequences add nothing', () => {
    assert.deepEqual(typeKeys({ typed: 'a' }, '\u001b[A\u001b[Db'), { typed: 'ab' })
    assert.deepEqual(typeKeys({ typed: 'a' }, '\u001b[200~xy\u001b[201~'), { typed: 'axy' })
  })
  test('Ctrl-C cancels, Ctrl-U clears, Ctrl-D on an empty line ends it', () => {
    assert.equal(typeKeys({ typed: 'abc' }, '\u0003').end, 'cancel')
    assert.deepEqual(typeKeys({ typed: 'abc' }, '\u0015'), { typed: '' })
    assert.deepEqual(typeKeys({ typed: '' }, '\u0004'), { typed: '', end: 'enter' })
  })
  test('keys after Enter are left alone', () => {
    assert.deepEqual(typeKeys({ typed: '' }, 'a\rb'), { typed: 'a', end: 'enter' })
  })
})

describe('pickSecret: is the paste the token this prompt wants', () => {
  test('the wanted token is taken, even pasted with other text around it', () => {
    assert.deepEqual(pickSecret(' xoxp-1-abc ', SECRETS.user), { value: 'xoxp-1-abc' })
    assert.deepEqual(pickSecret('Access Token xoxe.xoxp-1-a Refresh Token xoxe-1-b', SECRETS.config), { value: 'xoxe.xoxp-1-a' })
  })
  test('empty is empty, so the caller decides what Enter means', () => {
    assert.deepEqual(pickSecret('   ', SECRETS.user), { value: '' })
  })
  test('a known token of the wrong kind is named', () => {
    assert.match(pickSecret('xoxb-1-a', SECRETS.user).problem!, /bot token \(xoxb-/)
    assert.match(pickSecret('xoxe-1-b', SECRETS.config).problem!, /Refresh Token.*Access Token/)
  })
  test('text that is no token says what to paste', () => {
    assert.match(pickSecret('hello', SECRETS.app).problem!, /xapp-/)
  })
})

test('shownAs names the kind and length, never more than the prefix', () => {
  assert.equal(shownAs('xoxp-1234567890-secret'), 'xoxp-… (22 characters)')
  assert.ok(!shownAs('xoxp-1234567890-secret').includes('secret'))
  assert.equal(shownAs('sk-ant-oat01-abc'), 'sk-ant-oat… (16 characters)')
})
