import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { typeKeys, pickSecret, shownAs, SECRETS, fillSlackTokens, slackSlots, typeLines } from '../secret-prompt.ts'

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
    assert.deepEqual(typeKeys({ typed: 'a' }, '\u001bOAb'), { typed: 'ab' })
  })
  test('Ctrl-C cancels, Ctrl-U clears, Ctrl-D on an empty line ends it', () => {
    assert.equal(typeKeys({ typed: 'abc' }, '\u0003').end, 'cancel')
    assert.deepEqual(typeKeys({ typed: 'abc' }, '\u0015'), { typed: '' })
    assert.deepEqual(typeKeys({ typed: '' }, '\u0004'), { typed: '', end: 'enter' })
    assert.deepEqual(typeKeys({ typed: 'ab' }, '\u0004'), { typed: 'ab' })
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
    assert.match(pickSecret('xoxe-1-b', SECRETS.config).problem!, /^That is the Refresh Token\. Paste the Access Token/)
  })
  test('text that is no token says what to paste', () => {
    assert.match(pickSecret('hello', SECRETS.app).problem!, /xapp-/)
  })
  test('a signing secret has no prefix: it is 32 hex characters, and anything else is refused', () => {
    const sig = '0123456789abcdef0123456789abcdef'
    assert.deepEqual(pickSecret(` ${sig} `, SECRETS.signing), { value: sig })
    assert.match(pickSecret('xoxb-1-a', SECRETS.signing).problem!, /bot token \(xoxb-.*Paste the signing secret/)
    assert.match(pickSecret('0123', SECRETS.signing).problem!, /32 characters, 0-9 and a-f/)
    assert.equal(pickSecret(sig, SECRETS.user).problem, 'That is a signing secret. Paste the user token (xoxp-...).')
    assert.ok(!shownAs(sig).includes('0123'))
  })
})

test('shownAs names the kind and length, never more than the prefix', () => {
  assert.equal(shownAs('xoxp-1234567890-secret'), 'xoxp-… (22 characters)')
  assert.ok(!shownAs('xoxp-1234567890-secret').includes('secret'))
  assert.equal(shownAs('sk-ant-oat01-abc'), 'sk-ant-oat… (16 characters)')
})

describe('fillSlackTokens: one prompt takes the three Slack tokens in any order', () => {
  test('over HTTP the signing secret takes the app token\'s slot, and an app token is refused', () => {
    const sig = '0123456789abcdef0123456789abcdef'
    assert.deepEqual(fillSlackTokens({}, `xoxb-3 ${sig} xoxp-2`, 'http'), { slots: { bot: 'xoxb-3', signing: sig, user: 'xoxp-2' } })
    assert.match(fillSlackTokens({}, 'xapp-1', 'http').problem!, /signing secret, xoxp- and xoxb-/)
    assert.deepEqual(slackSlots('http').map(([k]) => k), ['signing', 'user', 'bot'])
    assert.deepEqual(slackSlots('socket').map(([k]) => k), ['app', 'user', 'bot'])
  })
  test('each token goes to its slot by its prefix, one paste or several', () => {
    const one = fillSlackTokens({}, 'xoxb-3 xapp-1')
    assert.deepEqual(one, { slots: { bot: 'xoxb-3', app: 'xapp-1' } })
    assert.deepEqual(fillSlackTokens(one.slots, ' xoxp-2 '), { slots: { bot: 'xoxb-3', app: 'xapp-1', user: 'xoxp-2' } })
  })
  test('a second token of a kind replaces the first, so a wrong paste is fixed by pasting again', () => {
    assert.deepEqual(fillSlackTokens({ user: 'xoxp-old' }, 'xoxp-new').slots, { user: 'xoxp-new' })
  })
  test('anything else is named and fills no slot', () => {
    const r = fillSlackTokens({ app: 'xapp-1' }, 'hello xoxp-2')
    assert.deepEqual(r.slots, { app: 'xapp-1', user: 'xoxp-2' })
    assert.match(r.problem!, /xapp-, xoxp- or xoxb-/)
    assert.match(fillSlackTokens({}, 'xoxe.xoxp-1-a').problem!, /configuration Access Token/)
  })
})

describe('typeLines: a hidden prompt that takes several lines in one session', () => {
  test('a paste ending in CR LF gives one line, not an empty second one', () => {
    assert.deepEqual(typeLines('', 'hello\r\n'), { typed: '', lines: ['hello'] })
  })
  test('three tokens on three lines give three lines, and text after the last Enter stays typed', () => {
    assert.deepEqual(typeLines('', 'xapp-1\nxoxp-2\rxoxb-3\r\nab'), { typed: 'ab', lines: ['xapp-1', 'xoxp-2', 'xoxb-3'] })
  })
  test('arrow keys add nothing to a token', () => {
    assert.deepEqual(typeLines('xoxb-1', '\u001b[A\u001b[D2'), { typed: 'xoxb-12', lines: [] })
  })
  test('Ctrl-C cancels', () => {
    assert.equal(typeLines('xo', 'x\u0003').cancel, true)
  })
})
