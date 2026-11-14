import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { commandRequest, parseCommands } from '../commands.ts'

describe('local slash commands', () => {
  const commands = parseCommands('/lookup=/opt/tc.mjs')
  const req = (o: Record<string, unknown> = {}) =>
    ({ team_id: 'TOURS', user_id: 'UANY', command: '/lookup', text: '9000000001 +919000000002', ...o })
  const opts = { team: 'TOURS', commands }
  test('anyone in the workspace gets the numbers, normalised and deduped', () => {
    assert.deepEqual(commandRequest(req({ text: '9000000001, +91-9000000002\n9000000001' }), opts),
      { ok: true, script: '/opt/tc.mjs', numbers: ['9000000001', '9000000002'] })
  })
  test('someone from another workspace (Slack Connect) is refused', () => {
    assert.equal(commandRequest(req({ team_id: 'TOTHER' }), opts).ok, false)
  })
  test('a command that is not configured is refused', () => {
    assert.equal(commandRequest(req({ command: '/deploy' }), opts).ok, false)
  })
  test('anything that is not a phone number is refused, never passed on', () => {
    for (const text of ['9000000001 --out /etc/passwd', '9000000001; rm -rf ~', 'hello', '$(whoami)', '12345'])
      assert.equal(commandRequest(req({ text }), opts).ok, false, text)
  })
  test('Indian shapes become 10 digits: +91, 91 and a leading 0', () => {
    const r = commandRequest(req({ text: '+919000000001 09000000002 919000000003' }), opts)
    assert.deepEqual(r.ok && r.numbers, ['9000000001', '9000000002', '9000000003'])
  })
  test('numbers the lookup cannot use are refused, not dropped', () => {
    for (const text of ['4412345678901', '123456789012', '-9000000001x'])
      assert.equal(commandRequest(req({ text }), opts).ok, false, text)
  })
  test('no numbers gives the usage line', () => {
    const r = commandRequest(req({ text: '  ' }), opts)
    assert.ok(!r.ok && /usage/i.test(r.reply))
  })
  test('a long list goes through whole', () => {
    const text = Array.from({ length: 150 }, (_, i) => String(9000000000 + i)).join(' ')
    const r = commandRequest(req({ text }), opts)
    assert.ok(r.ok && r.numbers.length === 150)
  })
  test('a bad KAGE_COMMANDS entry stops the start', () => {
    for (const bad of ['lookup=/opt/tc.mjs', '/lookup=relative.mjs', '/lookup'])
      assert.throws(() => parseCommands(bad), bad)
  })
  test('no KAGE_COMMANDS means no commands', () => assert.equal(parseCommands('').size, 0))
})
