import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Secrets, SecretsFile } from '../config.ts'
import { resolveSecrets, secretCommands } from '../secret-commands.ts'

const file = SecretsFile.parse({
  slack: { app: 'xapp-plain', bot: { command: 'op read op://kage/bot' }, user: { command: 'security find-generic-password -w -s kage-user' } },
  jevKey: { command: 'pass show kage/jev' },
  githubToken: null,
  waha: { WAHA_API_KEY: 'plain' },
  unknown: { OTHER: 'x' },
})

test('a secret may name a command, and secrets.json still refuses any other object', () => {
  assert.equal(SecretsFile.safeParse({ jevKey: { command: '' } }).success, false)
  assert.equal(SecretsFile.safeParse({ jevKey: { cmd: 'op read x' } }).success, false)
  assert.equal(SecretsFile.safeParse({ waha: { WAHA_API_KEY: { command: 'op read x' } } }).success, false)
  assert.equal(Secrets.safeParse({ jevKey: { command: 'op read x' } }).success, false)
})

test('secretCommands lists each secret that names a command, by its dotted path', () => {
  assert.deepEqual(secretCommands(file), [
    { path: 'slack.user', command: 'security find-generic-password -w -s kage-user' },
    { path: 'slack.bot', command: 'op read op://kage/bot' },
    { path: 'jevKey', command: 'pass show kage/jev' },
  ])
  assert.deepEqual(secretCommands(SecretsFile.parse({ slack: { app: 'a' } })), [])
})

test('resolveSecrets puts each command output in place, keeps plain values, and names each failed command', () => {
  const ran: string[] = []
  const out = resolveSecrets(file, (c: string) => { ran.push(c); return c.startsWith('op ') ? 'xoxb-from-op' : c.startsWith('pass ') ? undefined : 'xoxp-from-keychain' })
  assert.deepEqual(ran, ['security find-generic-password -w -s kage-user', 'op read op://kage/bot', 'pass show kage/jev'])
  assert.deepEqual(out.secrets, Secrets.parse({ slack: { app: 'xapp-plain', bot: 'xoxb-from-op', user: 'xoxp-from-keychain' }, githubToken: null, waha: { WAHA_API_KEY: 'plain' }, unknown: { OTHER: 'x' } }))
  assert.equal('jevKey' in out.secrets, false)
  assert.deepEqual(out.failed, [{ path: 'jevKey', command: 'pass show kage/jev' }])
})

test('a file with no commands resolves to itself and runs nothing', () => {
  const plain = SecretsFile.parse({ slack: { app: 'a', user: 'u', bot: 'b' }, claudeToken: 't' })
  const out = resolveSecrets(plain, () => assert.fail('ran a command'))
  assert.deepEqual(out, { secrets: plain, failed: [] })
})
