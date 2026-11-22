import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { connectLines, connectorStates, halfSetLines } from '../connect.ts'
import type { Config, Secrets } from '../config.ts'

const settings = (config: Partial<Config>, secrets: Partial<Secrets> = {}) => ({ config: { version: 1, ...config } as Config, secrets: secrets as Secrets })

describe('one table says whether each connector is on', () => {
  test('a connector with every setting it needs is on, and GitHub counts a token or a webhook secret', () => {
    const s = connectorStates(settings(
      { connectors: { github: { login: 'me', userId: 1, app: { id: 1, slug: 'kage-me' } }, email: { address: 'k@x.io', queue: 'q', ownerEmail: 'o@x.io' } } },
      { githubSecret: 's', githubAppKey: 'k', browserToken: 'b', voiceToken: 'v', waha: { WAHA_API_KEY: 'w' }, meetingToken: 'm' }))
    assert.deepEqual(Object.values(s).map(c => c.state), ['on', 'on', 'on', 'on', 'on', 'on'])
    assert.equal(connectorStates(settings({ connectors: { github: { login: 'me' } } }, { githubSecret: 's' })).github.state, 'unset')
  })

  test('a connector missing a setting names each one it lacks', () => {
    const s = connectorStates(settings({ connectors: { github: { login: 'me' }, email: { address: 'k@x.io' } } }))
    const missing = (c: typeof s.github) => c.state === 'unset' ? c.missing : []
    assert.deepEqual([missing(s.github), missing(s.email), missing(s.voice)], [['connectors.github.app.id', 'connectors.github.userId', 'githubAppKey', 'githubSecret'], ['connectors.email.queue', 'connectors.email.ownerEmail'], ['voiceToken']])
    assert.deepEqual([s.github.state, s.email.state, s.voice.state], ['unset', 'unset', 'unset'])
  })

  test('a connector the owner turned off is off, whatever else is set', () => {
    const s = connectorStates(settings({ connectors: { voice: { on: false }, whatsapp: { on: false }, email: { on: false } } }, { voiceToken: 'v' }))
    assert.deepEqual([s.voice, s.whatsapp, s.email], [{ state: 'off' }, { state: 'off' }, { state: 'off' }])
  })
})

describe('kage connect lists every connector with the one step left', () => {
  test('one row per connector: on, off with how to turn it back on, or what it still needs', () => {
    const s = settings({ connectors: { github: { login: 'me', userId: 1, app: { id: 1, slug: 'kage-me' } }, voice: { on: false }, email: { address: 'k@x.io' } } }, { githubSecret: 's', githubAppKey: 'k', voiceToken: 'v' })
    assert.deepEqual(connectLines(connectorStates(s)), [
      'on     github    ',
      'unset  browser   run kage connect browser',
      'unset  email     needs connectors.email.queue and connectors.email.ownerEmail: kage set <key> <value> (docs/settings.md, "Email")',
      'off    voice     run kage connect voice to turn it back on',
      'unset  whatsapp  needs waha.WAHA_API_KEY in secrets.json (docs/settings.md, "WhatsApp")',
      'unset  meeting   needs meetingToken in secrets.json (docs/settings.md, "Voice and calls")',
    ].map(l => l.trimEnd()))
  })
})

describe('kage doctor names a connector left half set up', () => {
  test('a connector with some of its settings and not all fails with its one step, and one never set up or turned off says nothing', () => {
    const s = settings({ connectors: { github: { login: 'me' }, email: { address: 'k@x.io' }, whatsapp: { on: false } } }, { voiceToken: 'v' })
    assert.deepEqual(halfSetLines(connectorStates(s)), [
      { kind: 'fail', text: 'github is half set up: run kage connect github' },
      { kind: 'fail', text: 'email is half set up: needs connectors.email.queue and connectors.email.ownerEmail: kage set <key> <value> (docs/settings.md, "Email")' },
    ])
    assert.deepEqual(halfSetLines(connectorStates(settings({}))), [])
  })
})
