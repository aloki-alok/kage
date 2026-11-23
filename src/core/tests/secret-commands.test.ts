import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Secrets, SecretsFile } from '../config.ts'
import { failedSecrets, lazySecrets, secretCommands } from '../secret-commands.ts'

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

test('lazySecrets runs a command only when its secret is read, and keeps plain values', () => {
  const ran: string[] = []
  const run = (c: string) => { ran.push(c); return c.startsWith('op ') ? 'xoxb-from-op' : c.startsWith('pass ') ? undefined : 'xoxp-from-keychain' }
  const s = lazySecrets(file, run)
  assert.equal(s.slack?.app, 'xapp-plain')
  assert.equal(s.githubToken, null)
  assert.deepEqual(s.waha, { WAHA_API_KEY: 'plain' })
  assert.deepEqual(ran, [], 'no command runs before its secret is read')
  assert.equal(s.slack?.bot, 'xoxb-from-op')
  assert.deepEqual(ran, ['op read op://kage/bot'])
  assert.equal(s.jevKey, undefined)
  assert.deepEqual({ ...s.slack }, { app: 'xapp-plain', user: 'xoxp-from-keychain', bot: 'xoxb-from-op' })
})

test('failedSecrets names each secret whose command printed nothing', () => {
  assert.deepEqual(failedSecrets(file, c => (c.startsWith('pass ') ? undefined : 'v')), [{ path: 'jevKey', command: 'pass show kage/jev' }])
  assert.deepEqual(failedSecrets(SecretsFile.parse({ slack: { app: 'a' } }), () => assert.fail('ran a command')), [])
})
