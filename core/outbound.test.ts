import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { findSecret, secretRefusal, splitForSlack } from './outbound.ts'


describe('long replies', () => {
  test('splits on line breaks under the limit and keeps every line', () => {
    const text = Array.from({ length: 50 }, (_, i) => `line ${i} ${'x'.repeat(80)}`).join('\n')
    const parts = splitForSlack(text, 1000)
    assert.ok(parts.every(p => p.length <= 1000))
    assert.equal(parts.join('\n'), text)
  })
  test('hard-splits a single line longer than the limit', () => {
    assert.deepEqual(splitForSlack('y'.repeat(2500), 1000).map(p => p.length), [1000, 1000, 500])
  })
})

describe('secrets never go to a thread', () => {
  test('flags the leak that happened: a password in a code span after the word password', () => {
    const leak = 'Temp AWS console password for Sam (user `sam`, sign in at <https://123456789012.signin.aws.amazon.com/console>):\n`Qx7#example-not-a-real-pw`\nIt works once.'
    assert.ok(findSecret(leak))
  })
  test('flags well-known token shapes', () => {
    for (const s of ['key AKIAIOSFODNN7EXAMPLE here', 'xoxb-1234567890-abcdefghij', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
      '-----BEGIN OPENSSH PRIVATE KEY-----', 'OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuv'])
      assert.ok(findSecret(s), s)
  })
  test('leaves normal work details alone', () => {
    for (const s of ['The temp password comes from the owner separately, never in Slack threads.',
      'SSM into `i-0abc123def4567890`, role `arn:aws:iam::123456789012:role/staging-ssm`',
      'Reset rows 3329 to 3335 at 21:00 UTC; head `16d8041a8`, run `aws ssm start-session --target i-0abc123def4567890`',
      'password reset flow fails in `resetPasswordController.ts`'])
      assert.equal(findSecret(s), undefined, s)
  })
})

describe('who may put a secret in a thread', () => {
  const pw = 'Temp password:\n`Qx7#example-not-a-real-pw`'
  test('refused by default, even for the owner', () => {
    assert.ok(secretRefusal(pw, { fromOwner: true }))
  })
  test('the owner can ask for it', () => {
    assert.equal(secretRefusal(pw, { fromOwner: true, ownerAsked: true }), undefined)
  })
  test('a teammate task cannot, even if the reply claims the owner asked', () => {
    assert.match(secretRefusal(pw, { fromOwner: false, ownerAsked: true }) ?? '', /teammate/)
  })
  test('private replies and secret-free text pass', () => {
    assert.equal(secretRefusal(pw, { fromOwner: false, private: true }), undefined)
    assert.equal(secretRefusal('done, rows reset', { fromOwner: false }), undefined)
  })
})
