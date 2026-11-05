import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { findSecret, layoutRefusal, secretRefusal, splitForSlack } from './outbound.ts'

describe('a long table split across messages stays a table', () => {
  const rows = Array.from({ length: 60 }, (_, i) => `+1555010${String(i).padStart(4, '0')}  Org ${i}`)
  const text = `*Idle numbers*\n\`\`\`\n${rows.join('\n')}\n\`\`\`\nDone.`
  test('a cut inside a ``` block closes it there and reopens it in the next part', () => {
    const parts = splitForSlack(text, 400)
    assert.ok(parts.length >= 3)
    for (const p of parts) assert.equal(p.split('```').length % 2, 1, `unbalanced part:\n${p}`)
    assert.ok(parts.every(p => p.length <= 400))
    // Every row shows in the code font: inside a block that its own message opens.
    for (const r of rows) {
      const p = parts.find(x => x.includes(r))
      assert.ok(p, r)
      assert.equal(p.slice(0, p.indexOf(r)).split('```').length % 2, 0, `outside a block: ${r}`)
    }
  })
})

describe('a cut never leaves an empty code block', () => {
  test('a cut just before the closing fence', () => {
    const text = `\`\`\`\n${'a'.repeat(386)}\n\`\`\`\nafter`
    const parts = splitForSlack(text, 400)
    assert.ok(parts.every(p => !p.includes('```\n```')), JSON.stringify(parts))
    assert.ok(parts.join('\n').includes('after'))
  })
  test('a limit too small for the fences still ends and keeps the text', () => {
    assert.equal(splitForSlack('abcdef', 5).join(''), 'abcdef')
  })
  test('a line longer than a whole message, inside a block', () => {
    const parts = splitForSlack(`\`\`\`\n${'b'.repeat(900)}\n\`\`\``, 400)
    assert.ok(parts.every(p => p.replaceAll('`', '').trim()), JSON.stringify(parts))
    assert.equal(parts.join('').replace(/[`\n]/g, ''), 'b'.repeat(900))
  })
})

describe('code blocks fit the Slack thread panel', () => {
  // A row shaped like one that wrapped in the thread panel: 74 characters.
  const wide = '+15550100248  Riverside Learning Academy Orga  never        2026-11-30'
  test('refuses a row wider than 60 characters inside a block, and says how to fix it', () => {
    assert.match(layoutRefusal(`Idle numbers:\n\`\`\`\n${wide}\n\`\`\``) ?? '', /60/)
  })
  test('also when the row sits on the fence line', () => {
    assert.ok(layoutRefusal(`\`\`\`${wide}\n\`\`\``))
  })
  test('a bar counts as one character: a 60-wide row of bars passes, 61 does not', () => {
    assert.equal(layoutRefusal(`\`\`\`\n${'█'.repeat(53)} 42 (5)\n\`\`\``), undefined)
    assert.ok(layoutRefusal(`\`\`\`\n${'█'.repeat(54)} 42 (5)\n\`\`\``))
  })
  test('long prose outside a block, and a log passed as wide, are left alone', () => {
    assert.equal(layoutRefusal(`${wide} ${wide}`), undefined)
    assert.equal(layoutRefusal(`\`\`\`\n${wide}\n\`\`\``, { wide: true }), undefined)
  })
})


describe('long replies', () => {
  test('splits on line breaks under the limit and keeps every line', () => {
    const text = Array.from({ length: 50 }, (_, i) => `line ${i} ${'x'.repeat(80)}`).join('\n')
    const parts = splitForSlack(text, 1000)
    assert.ok(parts.every(p => p.length <= 1000))
    assert.equal(parts.join('\n'), text)
  })
  test('hard-splits a single line longer than the limit', () => {
    const parts = splitForSlack('y'.repeat(2500), 1000)
    assert.equal(parts.length, 3)
    assert.ok(parts.every(p => p.length <= 1000))
    assert.equal(parts.join(''), 'y'.repeat(2500))
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
