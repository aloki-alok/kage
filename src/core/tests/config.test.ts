import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { ALIASES, checkSettings, settingTier, Config, diff, fromEnv, KEYS, mergeTeammateEmails, oldPeopleShape, Secrets, toEnv, unknownEnv, unknownNames } from '../config.ts'
import { parseEnv } from '../settings.ts'

const NOT_SETTINGS = ['KAGE_BIN', 'KAGE_OUTPUT_CHARS', 'KAGE_CALL_CODE', 'KAGE_CALL_REASON', 'KAGE_CLAUDE', 'KAGE_DIR', 'KAGE_ENV', 'KAGE_GIT_URL', 'KAGE_JOB_ID', 'KAGE_JOB_STATE_DIR', 'KAGE_KEYS_SOCK', 'KAGE_KEYS_TOKEN', 'KAGE_LINK_TOKEN','KAGE_MEETBOT_HUB', 'KAGE_MEETBOT_PIPELINE', 'KAGE_MEETBOT_PIPELINE_KEY', 'KAGE_MEETBOT_TOKEN', 'KAGE_PANE_SETTINGS', 'KAGE_READ_TOKEN', 'KAGE_REF','KAGE_SESSION', 'KAGE_SETUP_WAIT', 'KAGE_SLACK_API', 'KAGE_SSM_SOCK', 'KAGE_SSM_TOKEN', 'KAGE_TARBALL', 'KAGE_THREAD']

const FULL = `KAGE_NAME=kage
KAGE_RUNTIME=tmux
KAGE_ROUTE=plugin
KAGE_CWD=/work/home
KAGE_MEMORY=/work/mem
KAGE_OWNER_MEMORY=/work/owner-mem
KAGE_MAX_SESSIONS=6
KAGE_IDLE_MINUTES=45
KAGE_JOB_MODEL=haiku
KAGE_JOB_FRESH_EVERY=7
KAGE_JOB_CARRY=3
KAGE_JOB_CARRY_CHARS=200
KAGE_ROTATE_TOKENS=150000
KAGE_COMMAND_OUTPUT_CHARS=2000
KAGE_JOB_CATCH_UP_HOURS=6
KAGE_JOB_CATCH_UP_STAGGER_SECONDS=30
KAGE_DREAM_MIN_CHATS=3
KAGE_DREAM_MIN_CONFIDENCE=0.8
KAGE_DREAM_MAX_NEW=4
KAGE_DREAM_MAX_OUTDATED=2
KAGE_REPORT_ENABLED=off
KAGE_REPORT_PER_DAY=2
KAGE_REPORT_REPO=some-fork/kage
KAGE_REPORT_REDACT=Acme Corp,Bank of America
KAGE_REPORT_FAILURE_REPEATS=4
KAGE_JOB_LANE_DEFAULT=off
KAGE_LEAN_SESSIONS=off
KAGE_SANDBOX=on
KAGE_PLUGINS_OFF=hold-back@test-mods
KAGE_TRIPWIRES_MAX_POSTS=30
KAGE_TRIPWIRES_CATCH_UP_MAX=500
KAGE_TRIPWIRES_SEEN_MAX=300
KAGE_TRIPWIRES_HOOK_PORT=3198
KAGE_TRIPWIRES_HOOK_HOST=127.0.0.2
KAGE_TRIPWIRES_HOOK_PER_HOUR=30
KAGE_TRIPWIRES_SWAP_AFTER=3
KAGE_TRIPWIRES_SHADOW_WINDOW_MIN=30
KAGE_TRIPWIRES_SWAP_UNDO_DAYS=7
KAGE_WAITING_EXPIRE_HOURS=72
KAGE_OWNER_CHANNEL=slack
KAGE_TEAMMATES=UTEST0001,UTEST0002
KAGE_TRUSTED_PEOPLE=UTEST0001
KAGE_TRUSTED_APPS=ATEST0001:UTEST0001:UTEST0003,ATEST0002:ATEST0001,ATEST0009
KAGE_MAX_KAGELETS=7
KAGE_KAGELET_NEEDS_PER_DAY=4
KAGE_KAGELET_ASK_RUNS_PER_HOUR=4
KAGE_KAGELET_NOTES_KEPT=10
KAGE_KAGELET_NOTE_CHARS=2000
KAGE_KAGELET_MEASURE_MINUTES=30
KAGE_KAGELET_TREND_RUNS=6
KAGE_KAGELET_TURN_STALL_MINUTES=30
KAGE_KAGELET_INCIDENTS_PER_HOUR=4
KAGE_KAGELET_RELEASE=review
KAGE_KAGELET_REVIEWS_PER_DAY=4
KAGE_KAGELET_REVIEW_MODEL=haiku
KAGE_KAGELET_REVIEW_MIN_VERDICTS=20
KAGE_KAGELET_REVIEW_MIN_AGREEMENT=0.95
KAGE_KAGELET_REVIEW_EVIDENCE_DAYS=30
KAGE_KAGELET_DENY_HOLD_DAYS=7
KAGE_KAGELET_DAILY_USD=2.5
KAGE_KAGELET_OWNERS_MAX=4
KAGE_KAGELET_TOTAL_DAILY_USD=10
KAGE_KAGELET_CHAIN_USD=1.25
KAGE_DB_READ_COMMAND=/work/bin/db-read --flag
KAGE_DB_READ_MAX_ROWS=50
KAGE_AUTO_UPDATE=off
KAGE_ASK_OTHER_AGENTS=on
KAGE_SHARED_TOOLS=mcp__docs__,mcp__crm__read_
KAGE_AFK=off
KAGE_AFK_MODEL=haiku
KAGE_JEV_AGENTS=ATEST0001,ATEST0002
KAGE_JEV_THRESHOLD=0.7
KAGE_JEV_MODEL=jev-1.0.0
KAGE_JEV_ACK_WORDS=off
KAGE_JEV_URL=https://jev.example.com/v1
KAGE_TRIPWIRES=off
KAGE_TELEMETRY=off
KAGE_TELEMETRY_ENDPOINT=http://127.0.0.1:4318/otlp
KAGE_SCREEN_SHOT_LONG_SIDE=1280
KAGE_SCREEN_LOOK_ELEMENTS=60
KAGE_TOP_THREAD_COST_BAR=5
KAGE_TRUST_MODE=shadow
KAGE_TUNNEL_PROVIDER=tailscale
KAGE_TUNNEL_TARGETS=http://127.0.0.1:8789/github
KAGE_SLACK_TRANSPORT=auto
KAGE_SLACK_PUBLIC_URL=https://kage.example.test/slack
KAGE_TRIPWIRES_TIMEOUT_SEC=30
KAGE_TRIPWIRES_MAX_KB=32
KAGE_TRIPWIRES_FAIL_PING=5
KAGE_TRIPWIRES_PATTERN_MAX=100
KAGE_TRIPWIRES_LINE_MAX=500
KAGE_TRIPWIRES_ENV=PATH,HOME,SSH_AUTH_SOCK
KAGE_EMAIL=off
KAGE_MAIL_ADDRESS=kage@example.test
KAGE_MAIL_QUEUE=https://sqs.example.test/q
KAGE_OWNER_EMAIL=owner@example.test
KAGE_AWS_REGION=eu-west-1
KAGE_TEAMMATE_EMAILS=a@example.test,b@example.test
KAGE_VOICE=off
KAGE_VOICE_PORT=9001
KAGE_VOICE_MAX=2
KAGE_VOICE_PER_HOUR=30
KAGE_VOICE_MODEL=sonnet
KAGE_CALL_COMMAND=/work/bin/call
KAGE_GITHUB_LOGIN=octo-test
KAGE_GITHUB_PORT=9002
KAGE_GITHUB_PER_HOUR=15
KAGE_GITHUB_APP_ID=123456
KAGE_GITHUB_APP_SLUG=kage-octo
KAGE_GITHUB_ACCOUNTS=octo-test,acme
KAGE_GITHUB_USER_ID=4242
KAGE_MEETING_PORT=9003
KAGE_MEETING_PER_HOUR=5
KAGE_MEETING_AGENT_API=https://voice.example.test
KAGE_MEETING_AGENT_ID=7
KAGE_BROWSER_PORT=9004
KAGE_BROWSER_BLOCK=bank.example.test,vault.example.test
KAGE_WHATSAPP=off
KAGE_WA_MEMORY=/work/wa
KAGE_WA_MODEL=opus
KAGE_WAHA_URL=http://127.0.0.1:4000
KAGE_WA_HOOK_HOST=0.0.0.0
KAGE_WA_HOOK_PORT=4001
KAGE_WA_CHECK_MINUTES=2
KAGE_SMS=on
KAGE_SMS_PROVIDER=telnyx
KAGE_SMS_FROM=+14155550100
KAGE_SMS_PORT=8794
KAGE_SMS_PER_HOUR=40
KAGE_SMS_PER_MINUTE=20
KAGE_SMS_PUBLIC_URL=https://kage.example.test/sms
KAGE_SMS_ACCOUNT_SID=AC0TEST
KAGE_SMS_TELNYX_PUBLIC_KEY=telnyx-public-fake
KAGE_COMMANDS=/lookup=/work/lookup.mjs,/other=/work/other.mjs
SLACK_APP_TOKEN=xapp-test-fake
SLACK_USER_TOKEN=xoxp-test-fake
SLACK_BOT_TOKEN=xoxb-test-fake
SLACK_SIGNING_SECRET=signing-test-fake
KAGE_AWS_ACCESS_KEY_ID=AKIATESTFAKE
KAGE_AWS_SECRET_ACCESS_KEY=fake-secret-value
KAGE_VOICE_TOKEN=voice-fake
KAGE_GITHUB_SECRET=gh-fake
KAGE_GITHUB_APP_KEY=-----BEGIN RSA PRIVATE KEY-----\nFAKE\n-----END RSA PRIVATE KEY-----
KAGE_MEETING_TOKEN=meet-fake
KAGE_BROWSER_TOKEN=browser-fake
JEV_API_KEY=jev-fake
KAGE_VOICE_AGENT_KEY=voice-agent-fake
KAGE_CLAUDE_TOKEN=sk-ant-oat01-fake
KAGE_TWILIO_AUTH_TOKEN=twilio-fake
KAGE_TELNYX_API_KEY=telnyx-fake
`

describe('importing an env file', () => {
  test('every setting survives import then flatten, value for value', () => {
    const env = parseEnv(FULL)
    const { config, secrets } = fromEnv(env)
    assert.deepEqual(toEnv(config, secrets), env)
    const text = (e: Record<string, string>) => Object.entries(e).sort().map(([k, v]) => `${k}=${v}`).join('\n')
    assert.equal(text(toEnv(config, secrets)), text(env))
    assert.equal(config.unknown, undefined)
    Config.parse(JSON.parse(JSON.stringify(config)))
  })

  test('the fixture holds every setting the grep in docs/settings.md finds', () => {
    const found = execSync(`grep -rhoE 'KAGE_[A-Z_]+' --include=*.ts --include=*.sh . --exclude-dir=node_modules --exclude-dir=tests | sort -u`, { cwd: new URL('../../..', import.meta.url), encoding: 'utf8' }).trim().split('\n')
    const known = new Set([...KEYS.map(k => k.env), ...Object.keys(ALIASES), ...NOT_SETTINGS])
    assert.deepEqual(found.filter(n => !known.has(n)), [])
    const env = parseEnv(FULL)
    assert.deepEqual(KEYS.filter(k => !(k.env in env)).map(k => k.env), [])
  })

  test('tokens go to secrets, never to config', () => {
    const { config, secrets } = fromEnv(parseEnv(FULL))
    assert.equal(secrets.slack?.bot, 'xoxb-test-fake')
    assert.equal(secrets.jevKey, 'jev-fake')
    assert.ok(!JSON.stringify(config).includes('fake-secret'))
    assert.ok(!JSON.stringify(config).includes('xox'))
  })

  test('a line the table does not know, or a value that does not fit, is kept under unknown, a secret-looking one with its value only in secrets', () => {
    const { config, secrets } = fromEnv(parseEnv('KAGE_MAX_SESION=6\nKAGE_MAX_SESSIONS=many\nKAGE_NEW_TOKEN=xoxb-fake\nKAGE_TEAMMATES=priya\n'))
    assert.deepEqual(config.unknown, { KAGE_MAX_SESION: '6', KAGE_MAX_SESSIONS: 'many', KAGE_NEW_TOKEN: null, KAGE_TEAMMATES: 'priya' })
    assert.deepEqual(unknownNames(config), ['KAGE_MAX_SESION', 'KAGE_MAX_SESSIONS', 'KAGE_NEW_TOKEN', 'KAGE_TEAMMATES'])
    assert.deepEqual(toEnv(config, secrets), { KAGE_MAX_SESION: '6', KAGE_MAX_SESSIONS: 'many', KAGE_TEAMMATES: 'priya', KAGE_NEW_TOKEN: 'xoxb-fake' })
  })

  test('an unknown line whose value holds a credential goes to secrets.json whatever its name', () => {
    const env = { KAGE_DB_URL: 'postgres://app:hunter2@db.example.com/x', KAGE_WEBHOOK: 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8', KAGE_NOTE: 'meet at noon', KAGE_PATH: '/home/o/some/long/folder/name/for/a/project/x1', KAGE_PLAIN_URL: 'https://example.com/path' }
    const { config, secrets } = fromEnv(env)
    assert.deepEqual(secrets.unknown, { KAGE_DB_URL: env.KAGE_DB_URL, KAGE_WEBHOOK: env.KAGE_WEBHOOK })
    assert.ok(!JSON.stringify(config).includes('hunter2') && !JSON.stringify(config).includes('a1B2c3'))
    assert.deepEqual(config.unknown, { KAGE_DB_URL: null, KAGE_NOTE: 'meet at noon', KAGE_PATH: env.KAGE_PATH, KAGE_PLAIN_URL: env.KAGE_PLAIN_URL, KAGE_WEBHOOK: null })
    assert.deepEqual(toEnv(config, secrets), env)
  })
  test('an unknown line with a secret-looking name keeps its value in secrets.json and flattens back, and config.json never holds it', () => {
    const { config, secrets } = fromEnv({ OPENAI_API_KEY: 'sk-test', MY_TOKEN: 'tok-test' })
    assert.deepEqual(toEnv(config, secrets), { OPENAI_API_KEY: 'sk-test', MY_TOKEN: 'tok-test' })
    assert.deepEqual(secrets.unknown, { OPENAI_API_KEY: 'sk-test', MY_TOKEN: 'tok-test' })
    assert.ok(!JSON.stringify(config).includes('sk-test') && !JSON.stringify(config).includes('tok-test'))
    assert.deepEqual(unknownNames(config), ['MY_TOKEN', 'OPENAI_API_KEY'])
  })
  test('an old name fills the new one unless the new one is set', () => {
    assert.equal(fromEnv({ KAGE_MAX_SPECIALISTS: '3' }).config.kagelets?.max, 3)
    assert.equal(fromEnv({ KAGE_MAX_SPECIALISTS: '3', KAGE_MAX_KAGELETS: '5' }).config.kagelets?.max, 5)
  })

  test('a list with spaces and a number with a trailing zero keep their meaning', () => {
    const { config, secrets } = fromEnv({ KAGE_BROWSER_BLOCK: 'a.test, b.test', KAGE_KAGELET_DAILY_USD: '2.50' })
    assert.deepEqual(toEnv(config, secrets), { KAGE_BROWSER_BLOCK: 'a.test,b.test', KAGE_KAGELET_DAILY_USD: '2.5' })
  })
})

describe('the schema', () => {
  test('a cost cap that is not a number of dollars, or a slash command that is not a name and an absolute path, is refused', () => {
    for (const bad of ['two', -1, Number.NaN]) assert.throws(() => Config.parse({ version: 1, kagelets: { dailyUsd: bad } }), /dailyUsd/, String(bad))
    for (const bad of [{ lookup: '/opt/x.mjs' }, { '/lookup': 'relative.mjs' }]) assert.throws(() => Config.parse({ version: 1, connectors: { commands: bad } }), /commands/, JSON.stringify(bad))
    assert.deepEqual(fromEnv({ KAGE_KAGELET_DAILY_USD: 'two' }).config.unknown, { KAGE_KAGELET_DAILY_USD: 'two' })
  })
  test('a session key names one plain host: a path, a port, a user or an upper-case name is refused (#182)', () => {
    Config.parse({ version: 1, sessionKeys: { API_KEY: { host: 'api.example.test', header: 'x-api-key', prefix: '' } } })
    for (const host of ['api.example.test/x', 'api.example.test:443', 'a@b.test', '']) assert.throws(() => Config.parse({ version: 1, sessionKeys: { API_KEY: { host } } }), /sessionKeys/, host)
    assert.throws(() => Config.parse({ version: 1, sessionKeys: { api_key: { host: 'a.test' } } }), /sessionKeys/)
  })
  test('a typo in a key is refused with its name', () => {
    assert.throws(() => Config.parse({ version: 1, harness: { maxSesion: 6 } }), /maxSesion/)
  })
})

describe('diff', () => {
  const a = fromEnv(parseEnv(FULL))
  test('a people change is live, anything else waits for a restart, and no value is named', () => {
    const b = fromEnv({ ...parseEnv(FULL), KAGE_TEAMMATES: 'UTEST0001', KAGE_MAX_SESSIONS: '9', SLACK_BOT_TOKEN: 'xoxb-other-fake' })
    const d = diff(a, b)
    assert.deepEqual(d, { live: ['people.teammates'], restart: ['harness.maxSessions', 'secrets.slack.bot'] })
    assert.ok(!JSON.stringify(d).includes('xoxb'))
  })
  test('the same files differ in nothing', () => {
    assert.deepEqual(diff(a, fromEnv(parseEnv(FULL))), { live: [], restart: [] })
  })
})

describe('people and the registry', () => {
  test('entries go into config.people and come back the same', async () => {
    const { registryOf, withRegistry } = await import('../config.ts')
    const entries = [
      { kind: 'person' as const, id: 'UTEST0001' },
      { kind: 'agent' as const, id: 'ATEST0001', owner: 'UTEST0001', tag: 'UTEST0003' },
      { kind: 'agent' as const, id: 'ATEST0009' },
    ]
    const c = Config.parse(withRegistry({ version: 1, name: 'kage' }, entries))
    assert.deepEqual(registryOf(c), entries)
    assert.equal(c.name, 'kage')
    assert.equal(toEnv(c, {}).KAGE_TRUSTED_APPS, 'ATEST0001:UTEST0001:UTEST0003,ATEST0009')
  })
  test('a trusted person round-trips, and removing them drops the trust too (#425)', async () => {
    const { registryOf, withRegistry, checkSettings } = await import('../config.ts')
    const entries = [{ kind: 'person' as const, id: 'UTEST0001', trusted: true as const }, { kind: 'person' as const, id: 'UTEST0002' }]
    const c = Config.parse(withRegistry({ version: 1, name: 'kage' }, entries))
    assert.deepEqual(c.people?.teammates, [{ user: 'UTEST0001', trusted: true }, { user: 'UTEST0002' }])
    assert.deepEqual(registryOf(c), entries)
    const ok = checkSettings(c, { version: 1, slack: { app: 'a', user: 'u', bot: 'b' } } as never)
    assert.deepEqual('trusted' in ok && ok.trusted, ['UTEST0001'])
    assert.deepEqual(Config.parse(withRegistry(c, [entries[1]!])).people?.teammates, [{ user: 'UTEST0002' }])
  })
  test('each teammate is one entry: a Slack user, an email, or both, with trust on the entry', () => {
    const c = Config.parse({ version: 1, people: { teammates: [{ user: 'UTEST0001', email: 'a@example.test', trusted: true }, { email: 'b@example.test' }, { user: 'UTEST0002' }] } })
    const ok = checkSettings(c, { slack: { app: 'a', user: 'u', bot: 'b' } })
    assert.deepEqual(ok, { name: 'kage', teammates: ['UTEST0001', 'UTEST0002'], trusted: ['UTEST0001'], emails: ['a@example.test', 'b@example.test'], apps: [] })
    assert.throws(() => Config.parse({ version: 1, people: { teammates: [{}] } }), /teammates/)
    assert.throws(() => Config.parse({ version: 1, people: { teammates: [{ email: 'b@example.test', trusted: true }] } }), /teammates/)
    assert.throws(() => Config.parse({ version: 1, people: { teammates: [{ email: 'not an address' }] } }), /teammates/)
  })
  test('adding or removing a person keeps every email: on the person while listed, and the email-only entries', async () => {
    const { registryOf, withRegistry } = await import('../config.ts')
    const c = Config.parse({ version: 1, people: { teammates: [{ user: 'UTEST0001', email: 'a@example.test' }, { email: 'b@example.test' }] } })
    const added = Config.parse(withRegistry(c, [...registryOf(c), { kind: 'person', id: 'UTEST0002' }]))
    assert.deepEqual(added.people?.teammates, [{ user: 'UTEST0001', email: 'a@example.test' }, { user: 'UTEST0002' }, { email: 'b@example.test' }])
    assert.deepEqual(Config.parse(withRegistry(added, [{ kind: 'person', id: 'UTEST0002' }])).people?.teammates, [{ user: 'UTEST0002' }, { email: 'b@example.test' }])
  })
  test('a config.json from an older Kage folds its three teammate lists into one, and a trusted id that is no teammate is dropped (#435)', () => {
    const c = Config.parse({ version: 1, people: { teammates: ['UTEST0001', 'UTEST0002'], trusted: ['UTEST0001', 'UTEST0009'] }, connectors: { email: { on: true, teammateEmails: ['a@example.test'] } } })
    assert.deepEqual(c.people, { teammates: [{ user: 'UTEST0001', trusted: true }, { user: 'UTEST0002' }, { email: 'a@example.test' }] })
    assert.deepEqual(c.connectors, { email: { on: true } })
    const mixed = Config.parse({ version: 1, people: { teammates: [{ user: 'UTEST0001' }, 'UTEST0002'], trusted: ['UTEST0001'] } })
    assert.deepEqual(mixed.people?.teammates, [{ user: 'UTEST0001', trusted: true }, { user: 'UTEST0002' }])
    const messy = Config.parse({ version: 1, connectors: { email: { on: true, teammateEmails: [' a@example.test ', 'bob'] } } })
    assert.deepEqual(messy.people?.teammates, [{ email: 'a@example.test' }])
  })
  test('the fold of the three old teammate lists is deleted from core/config.ts by 2027-01-31', () => {
    assert.ok(Date.now() < Date.parse('2027-01-31'), 'delete foldOldPeople, oldPeopleShape, mergeTeammateEmails, tidyPeople, ownerLines.peopleTidied, the config.json.before-tidy- sweep prefix, their tests and this test')
  })
  test('only a file with an old teammate list counts as the old shape', () => {
    assert.equal(oldPeopleShape({ version: 1, people: { teammates: ['UTEST0001'] } }), true)
    assert.equal(oldPeopleShape({ version: 1, people: { teammates: [{ user: 'UTEST0001' }], trusted: [] } }), true)
    assert.equal(oldPeopleShape({ version: 1, connectors: { email: { on: true, teammateEmails: [] } } }), true)
    assert.equal(oldPeopleShape({ version: 1, people: { teammates: [{ user: 'UTEST0001' }, { email: 'a@example.test' }] } }), false)
    assert.equal(oldPeopleShape({ version: 1 }), false)
    assert.equal(oldPeopleShape(null), false)
  })
  test("an email-only teammate moves onto the listed Slack user it belongs to, and keeps that user's trust", () => {
    const listed = [{ user: 'UTEST0001', trusted: true as const }, { user: 'UTEST0002' }, { email: 'a@example.test' }, { email: 'b@example.test' }]
    const merged = mergeTeammateEmails(listed, { 'a@example.test': 'UTEST0001', 'b@example.test': 'UTEST0009' })
    assert.deepEqual(merged.teammates, [{ user: 'UTEST0001', email: 'a@example.test', trusted: true }, { user: 'UTEST0002' }, { email: 'b@example.test' }])
    assert.deepEqual(merged.moved, [{ email: 'a@example.test', user: 'UTEST0001' }])
  })
  test('a user that already has an email keeps it, and the other email stays its own entry', () => {
    const listed = [{ user: 'UTEST0001', email: 'old@example.test' }, { email: 'a@example.test' }]
    assert.deepEqual(mergeTeammateEmails(listed, { 'a@example.test': 'UTEST0001' }), { teammates: listed, moved: [] })
  })
  test('two emails for one user: only the first moves onto it', () => {
    const listed = [{ user: 'UTEST0001' }, { email: 'a@example.test' }, { email: 'b@example.test' }]
    const merged = mergeTeammateEmails(listed, { 'a@example.test': 'UTEST0001', 'b@example.test': 'UTEST0001' })
    assert.deepEqual(merged.teammates, [{ user: 'UTEST0001', email: 'a@example.test' }, { email: 'b@example.test' }])
  })
  test('the old env lines for teammates, trust and teammate emails import into the one list', () => {
    const { config } = fromEnv(parseEnv(FULL))
    assert.deepEqual(config.people?.teammates, [{ user: 'UTEST0001', trusted: true }, { user: 'UTEST0002' }, { email: 'a@example.test' }, { email: 'b@example.test' }])
    assert.equal(JSON.stringify(config.connectors?.email).includes('teammate'), false)
  })
})

describe('what the hub needs to run', () => {
  const secrets = { slack: { app: 'xapp-fake', user: 'xoxp-fake', bot: 'xoxb-fake' } }
  test('a good config gives the name and both people lists, an agent as app:owner:tag', () => {
    const config = Config.parse({ version: 1, people: { teammates: [{ user: 'UTEST0001' }], agents: [{ app: 'ATEST0001', owner: 'UTEST0001', tag: 'UTEST0003' }, { app: 'ATEST0009' }] } })
    assert.deepEqual(checkSettings(config, secrets), { name: 'kage', teammates: ['UTEST0001'], trusted: [], emails: [], apps: ['ATEST0001:UTEST0001:UTEST0003', 'ATEST0009'] })
  })
  test('a missing token is refused by its path, and a bad name by itself', () => {
    assert.match((checkSettings({ version: 1 }, { slack: { app: 'a', bot: 'b' } }) as { error: string }).error, /slack\.user/)
    assert.match((checkSettings({ version: 1, name: 'Not A Name' }, secrets) as { error: string }).error, /name/)
  })
  test('Slack over HTTP needs the signing secret and no app token, and Socket Mode the reverse', () => {
    const http = { version: 1, slack: { transport: 'http' } } as Config, webOnly = { slack: { user: 'u', bot: 'b', signing: 's' } }
    assert.equal((checkSettings(http, secrets) as { error: string }).error, 'slack.signing is missing in secrets.json')
    assert.ok(!('error' in checkSettings(http, webOnly)))
    assert.equal((checkSettings({ version: 1 }, webOnly) as { error: string }).error, 'slack.app is missing in secrets.json')
  })
  test('a value the hub would exit or crash on is refused: a quote in a path, a port out of range', () => {
    const bad = (c: object) => (checkSettings({ version: 1, ...c } as Config, secrets) as { error: string }).error
    assert.match(bad({ harness: { memory: '/tmp/it\'s' } }), /harness\.memory/)
    assert.match(bad({ harness: { ownerMemory: '/tmp/a"b' } }), /harness\.ownerMemory/)
    assert.match(bad({ harness: { cwd: '/tmp/a\\b' } }), /harness\.cwd/)
    assert.match(bad({ connectors: { whatsapp: { memory: "/tmp/x'y" } } }), /whatsapp\.memory/)
    for (const [k, port] of [['voice', 0], ['github', 70000], ['voice', 80], ['meeting', 1023], ['meeting', -1], ['browser', 8791.5]] as const) assert.match(bad({ connectors: { [k]: { port } } }), new RegExp(`connectors\\.${k}\\.port`), k)
    assert.match(bad({ connectors: { whatsapp: { hookPort: 99999 } } }), /whatsapp\.hookPort/)
    assert.match(bad({ tripwires: { hookPort: 80 } }), /tripwires\.hookPort/)
    assert.equal(bad({ tripwires: { hookPort: 0 } }), undefined)
    assert.ok(!('error' in checkSettings({ version: 1, harness: { memory: '~/mem dir' }, connectors: { voice: { port: 8790 } } } as Config, secrets)))
  })
  test('a wrong people entry is refused by the schema, and an agent owner who is not a person or an agent too', () => {
    assert.throws(() => Config.parse({ version: 1, people: { teammates: ['priya'] } }), /teammates/)
    assert.throws(() => Config.parse({ version: 1, people: { agents: [{ app: 'ATEST0001', owner: 'priya' }] } }), /agents/)
    assert.throws(() => Config.parse({ version: 1, people: { agents: [{ app: 'UTEST0001' }] } }), /agents/)
  })
})

describe('docs/settings.md', () => {
  test('names exactly the keys in the table, one row each', () => {
    const docs = readFileSync(new URL('../../../docs/settings.md', import.meta.url), 'utf8')
    const listed = docs.split('\n').filter(l => l.startsWith('| `')).flatMap(l => [...l.split('|')[1]!.matchAll(/`([^`]+)`/g)].map(m => m[1]!))
    const keys = KEYS.map(k => k.path)
    assert.deepEqual(keys.filter(k => !listed.includes(k)), [], 'in the table, missing from the docs')
    assert.deepEqual(listed.filter(k => !keys.includes(k)), [], 'in the docs, missing from the table')
    assert.equal(new Set(listed).size, listed.length, 'a key listed twice')
  })
})

describe('which keys a session may change on its own', () => {
  test('limits, models, AFK, Jev thresholds, job lanes, tripwire numbers, ports and the browser block list are safe', () => {
    for (const k of ['waiting.expireHours', 'top.threadCostBar', 'kagelets.max', 'kagelets.dailyUsd', 'kagelets.totalDailyUsd', 'kagelets.chainUsd', 'kagelets.needsPerDay', 'kagelets.measureMinutes', 'kagelets.trendRuns', 'kagelets.turnStallMinutes', 'kagelets.incidentsPerHour', 'afk.on', 'afk.model', 'harness.jobModel', 'harness.jobFreshEvery', 'harness.jobCarry', 'harness.jobCarryChars', 'harness.rotateTokens', 'harness.jobLaneDefault', 'harness.jobCatchUpHours', 'harness.jobCatchUpStaggerSeconds', 'jev.threshold', 'jev.model', 'tripwires.timeoutSec', 'tripwires.maxKb', 'tripwires.failPing', 'tripwires.patternMax', 'tripwires.lineMax', 'tripwires.maxPosts', 'tripwires.catchUpMax', 'tripwires.seenMax', 'tripwires.hookPerHour', 'connectors.voice.port', 'connectors.voice.max', 'connectors.github.perHour', 'connectors.browser.port', 'connectors.whatsapp.model', 'connectors.whatsapp.hookPort', 'connectors.whatsapp.checkMinutes']) assert.equal(settingTier(k), 'safe', k)
  })
  test('anything that grants power needs the owner: people, a command, a connector on, harness, and any key not listed', () => {
    for (const k of ['people.teammates', 'people.agents', 'askOtherAgents', 'connectors.call.command', 'kagelets.dbRead.command', 'kagelets.dbRead.maxRows', 'dbRead.routes', 'dbRead.routes.prod', 'dbRead.maxRows', 'kagelets.release', 'kagelets.reviewsPerDay', 'kagelets.reviewModel', 'kagelets.reviewMinVerdicts', 'kagelets.reviewMinAgreement', 'kagelets.reviewEvidenceDays', 'kagelets.denyHoldDays', 'connectors.commands', 'connectors.email.on', 'connectors.voice.on', 'connectors.whatsapp.on', 'connectors.whatsapp.hookHost', 'harness.maxSessions', 'harness.sandbox', 'harness.pluginsOff', 'dream.minChats', 'dream.minConfidence', 'dream.maxNew', 'dream.maxOutdated', 'harness.route', 'harness.cwd', 'autoUpdate', 'name', 'connectors.email.address', 'jev.agents', 'connectors.browser.block', 'sharedTools', 'tripwires.on', 'tripwires.env', 'tripwires.hookPort', 'tripwires.hookHost', 'connectors.github.approve', 'connectors.github.approve.policyRepo']) assert.equal(settingTier(k), 'power', k)
  })
  test('secrets, the schema version and unplaced env lines are never settable, and a prototype path is refused', () => {
    for (const k of ['secrets', 'secrets.slack.bot', 'version', 'unknown', 'unknown.KAGE_X', '__proto__.x', 'harness.__proto__.x', 'constructor.prototype.x', '']) assert.equal(settingTier(k), 'never', k)
  })
})

describe('the old env file\'s own keys', () => {
  test('a key Kage has no setting for comes back as an env line, a secret one too, so sessions keep it after the import', () => {
    const { config, secrets } = fromEnv({ MY_TOOL_URL: 'https://x.test', MY_TOOL_API_KEY: 'sk-test-1234567890abcdef', SLACK_BOT_TOKEN: 'xoxb-TEST' })
    assert.deepEqual(unknownEnv(config, secrets), { MY_TOOL_URL: 'https://x.test', MY_TOOL_API_KEY: 'sk-test-1234567890abcdef' })
  })
})

describe('a secrets.json from an older Kage', () => {
  test('still loads when it holds the GitHub token the old connector used, so the hub keeps starting', () => {
    assert.equal(Secrets.safeParse({ githubToken: 'ghp_old', githubSecret: 's' }).success, true)
  })
})
