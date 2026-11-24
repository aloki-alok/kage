import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { choiceAsk, connectAsks, connectLines, connectorStates, halfSetLines, type ConnectorName } from '../connect.ts'
import type { Config, Secrets } from '../config.ts'

const settings = (config: Partial<Config>, secrets: Partial<Secrets> = {}) => ({ config: { version: 1, ...config } as Config, secrets: secrets as Secrets })

describe('one table says whether each connector is on', () => {
  test('a connector with every setting it needs is on, and GitHub counts a token or a webhook secret', () => {
    const s = connectorStates(settings(
      { connectors: { github: { login: 'me', userId: 1, app: { id: 1, slug: 'kage-me' } }, email: { address: 'k@x.io', queue: 'q', ownerEmail: 'o@x.io' }, sms: { from: '+14155550100', publicUrl: 'https://kage.example.test/sms', telnyxPublicKey: 'p' } } },
      { githubSecret: 's', githubAppKey: 'k', browserToken: 'b', voiceToken: 'v', waha: { WAHA_API_KEY: 'w' }, meetingToken: 'm', telnyxApiKey: 'k' }))
    assert.deepEqual(Object.values(s).map(c => c.state), ['on', 'on', 'on', 'on', 'on', 'on', 'on'])
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
      'unset  email     needs connectors.email.queue and connectors.email.ownerEmail: run kage connect email in a terminal to be asked (docs/settings.md, "Email")',
      'off    voice     run kage connect voice to turn it back on',
      'unset  whatsapp  needs waha.WAHA_API_KEY: run kage connect whatsapp in a terminal to be asked (docs/settings.md, "WhatsApp")',
      'unset  meeting   needs meetingToken: run kage connect meeting in a terminal to be asked (docs/settings.md, "Voice and calls")',
      'unset  sms       needs connectors.sms.from, connectors.sms.publicUrl, connectors.sms.telnyxPublicKey and telnyxApiKey: run kage connect sms in a terminal to be asked (docs/settings.md, "SMS")',
    ].map(l => l.trimEnd()))
  })
})

describe('kage doctor names a connector left half set up', () => {
  test('a connector with some of its settings and not all fails with its one step, and one never set up or turned off says nothing', () => {
    const s = settings({ connectors: { github: { login: 'me' }, email: { address: 'k@x.io' }, whatsapp: { on: false } } }, { voiceToken: 'v' })
    assert.deepEqual(halfSetLines(connectorStates(s)), [
      { kind: 'fail', text: 'github is half set up: run kage connect github' },
      { kind: 'fail', text: 'email is half set up: needs connectors.email.queue and connectors.email.ownerEmail: run kage connect email in a terminal to be asked (docs/settings.md, "Email")' },
    ])
    assert.deepEqual(halfSetLines(connectorStates(settings({}))), [])
  })
})

describe('SMS needs the keys of the provider it uses', () => {
  const sms = { from: '+14155550100', publicUrl: 'https://kage.example.test/sms' }
  test('Telnyx, the default, needs its public key and API key, and Twilio the account SID and auth token', () => {
    const missing = (c: ReturnType<typeof connectorStates>['sms']) => c.state === 'unset' ? c.missing : [c.state]
    assert.deepEqual(missing(connectorStates(settings({ connectors: { sms } })).sms), ['connectors.sms.telnyxPublicKey', 'telnyxApiKey'])
    assert.deepEqual(missing(connectorStates(settings({ connectors: { sms: { ...sms, telnyxPublicKey: 'p' } } }, { telnyxApiKey: 'k' })).sms), ['on'])
    assert.deepEqual(missing(connectorStates(settings({ connectors: { sms: { ...sms, provider: 'twilio' } } }, { telnyxApiKey: 'k' })).sms), ['connectors.sms.accountSid', 'twilioAuthToken'])
    assert.deepEqual(missing(connectorStates(settings({ connectors: { sms: { ...sms, provider: 'twilio', accountSid: 'AC0TEST' } } }, { twilioAuthToken: 't' })).sms), ['on'])
    assert.deepEqual(missing(connectorStates(settings({}, {})).sms), ['connectors.sms.from', 'connectors.sms.publicUrl', 'connectors.sms.telnyxPublicKey', 'telnyxApiKey'])
  })
  test('SMS the owner turned off is off, and its row points at the SMS settings', () => {
    assert.deepEqual(connectorStates(settings({ connectors: { sms: { ...sms, on: false, telnyxPublicKey: 'p' } } }, { telnyxApiKey: 'k' })).sms, { state: 'off' })
    assert.equal(connectLines(connectorStates(settings({ connectors: { sms } }))).at(-1), 'unset  sms       needs connectors.sms.telnyxPublicKey and telnyxApiKey: run kage connect sms in a terminal to be asked (docs/settings.md, "SMS")')
  })
})

describe('kage connect asks for what is missing (#570)', () => {
  const empty = connectorStates({ config: {} as Config, secrets: {} as Secrets })
  const asked: ConnectorName[] = ['email', 'voice', 'whatsapp', 'meeting', 'sms']
  test('every missing setting of every asked connector has a question, so none falls back to a key name', () => {
    for (const n of asked) {
      const s = empty[n]
      assert.equal(s.state, 'unset')
      const asks = connectAsks(s.state === 'unset' ? s.missing : [])
      assert.deepEqual(asks.map(a => a.key).filter(k => s.state === 'unset' && s.missing.includes(k)), s.state === 'unset' ? s.missing : [])
      for (const a of asks) assert.ok(a.question.length > 10 && !a.question.includes('connectors.'), `${n} ${a.key}: ${a.question}`)
    }
  })
  test('a provider token is asked hidden, a plain value is asked in the open, and a token only Kage uses is made, not asked', () => {
    const kind = (k: string) => connectAsks([k]).find(a => a.key === k)!.kind
    assert.equal(kind('twilioAuthToken'), 'secret')
    assert.equal(kind('telnyxApiKey'), 'secret')
    assert.equal(kind('connectors.sms.from'), 'plain')
    assert.equal(kind('connectors.email.queue'), 'plain')
    assert.equal(kind('voiceToken'), 'made')
    assert.equal(kind('meetingToken'), 'made')
  })
  test('the WhatsApp bridge gets both of its keys made together', () => {
    assert.deepEqual(connectAsks(['waha.WAHA_API_KEY']).map(a => [a.key, a.kind]), [['waha.WAHA_API_KEY', 'made'], ['waha.WHATSAPP_HOOK_HMAC_KEY', 'made']])
  })
  test('an SMS number must be in E.164, and a public URL must end in /sms', () => {
    const check = (k: string, v: string) => connectAsks([k])[0]!.check?.(v)
    assert.equal(check('connectors.sms.from', '+14155550100'), undefined)
    assert.match(check('connectors.sms.from', '415 555 0100')!, /\+14155550100/)
    assert.equal(check('connectors.sms.publicUrl', 'https://x.ts.net/sms'), undefined)
    assert.match(check('connectors.sms.publicUrl', 'https://x.ts.net')!, /\/sms/)
  })
})

describe('a connector with a choice asks it first (#570)', () => {
  test('SMS with no provider asks which one, and takes only twilio or telnyx', () => {
    const a = choiceAsk('sms', {} as Config)!
    assert.equal(a.key, 'connectors.sms.provider')
    assert.deepEqual(a.choices, ['telnyx', 'twilio'])
    assert.equal(a.check!('twilio'), undefined)
    assert.match(a.check!('vonage')!, /telnyx or twilio/)
  })
  test('a provider already set, or another connector, asks nothing', () => {
    assert.equal(choiceAsk('sms', { connectors: { sms: { provider: 'twilio' } } } as Config), undefined)
    assert.equal(choiceAsk('email', {} as Config), undefined)
  })
})
