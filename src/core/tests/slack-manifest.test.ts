import { test } from 'node:test'
import assert from 'node:assert/strict'
import { slackManifest } from '../slack-manifest.ts'
import { BOT_SCOPES, USER_SCOPES } from '../slack-scopes.ts'

test('Socket Mode: the app opens its own connection, so nothing in it names a URL', () => {
  const m = slackManifest({ name: 'kage', transport: 'socket' })
  assert.equal(m.display_information.name, 'Kage')
  assert.equal(m.features.bot_user.display_name, 'kage')
  assert.deepEqual(m.oauth_config.scopes, { bot: BOT_SCOPES, user: USER_SCOPES })
  assert.equal(m.settings.socket_mode_enabled, true)
  assert.doesNotMatch(JSON.stringify(m), /request_url|"url"/)
})

test('HTTP: Socket Mode is off, and events and each slash command go to the public Slack route', () => {
  const url = 'https://hub.example.test:8443/slack'
  const m = slackManifest({ name: 'kage', transport: 'http', url, commands: ['/truecaller'] })
  assert.equal(m.settings.socket_mode_enabled, false)
  assert.equal(m.settings.event_subscriptions.request_url, url)
  assert.deepEqual(m.settings.event_subscriptions.user_events, slackManifest({ name: 'kage', transport: 'socket' }).settings.event_subscriptions.user_events)
  assert.deepEqual(m.features.slash_commands?.map(c => [c.command, c.url]), [['/truecaller', url]])
})

test('HTTP with no slash commands lists none', () => {
  const m = slackManifest({ name: 'kage', transport: 'http', url: 'https://hub.example.test:8443/slack', commands: [] })
  assert.equal(m.features.slash_commands, undefined)
})
