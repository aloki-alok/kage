import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { execSync } from 'node:child_process'
import { ALIASES, Config, diff, fromEnv, KEYS, NOT_SETTINGS, toEnv, unknownNames } from '../config.ts'
import { parseEnv } from '../settings.ts'

// One line for every setting in the table, with fake values. Canonical forms: the shape toEnv writes.
const FULL = `KAGE_NAME=kage
KAGE_RUNTIME=tmux
KAGE_ROUTE=plugin
KAGE_CWD=/work/home
KAGE_MEMORY=/work/mem
KAGE_OWNER_MEMORY=/work/owner-mem
KAGE_MAX_SESSIONS=6
KAGE_IDLE_MINUTES=45
KAGE_TEAMMATES=UTEST0001,UTEST0002
KAGE_TRUSTED_APPS=ATEST0001:UTEST0001:UTEST0003,ATEST0002:ATEST0001,ATEST0009
KAGE_MAX_KAGELETS=7
KAGE_KAGELET_DAILY_USD=2.5
KAGE_KAGELET_TOTAL_DAILY_USD=10
KAGE_KAGELET_CHAIN_USD=1.25
KAGE_DB_READ_COMMAND=/work/bin/db-read --flag
KAGE_DB_READ_MAX_ROWS=50
KAGE_AUTO_UPDATE=off
KAGE_AFK=off
KAGE_AFK_MODEL=haiku
KAGE_JEV_AGENTS=ATEST0001,ATEST0002
KAGE_JEV_THRESHOLD=0.7
KAGE_JEV_MODEL=jev-1.0.0
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
KAGE_CALL_COMMAND=/work/bin/call
KAGE_GITHUB_LOGIN=octo-test
KAGE_GITHUB_PORT=9002
KAGE_GITHUB_PER_HOUR=15
KAGE_MEETING_PORT=9003
KAGE_MEETING_PER_HOUR=5
KAGE_BROWSER_PORT=9004
KAGE_BROWSER_BLOCK=bank.example.test,vault.example.test
KAGE_WHATSAPP=off
KAGE_WA_MEMORY=/work/wa
KAGE_WA_MODEL=opus
KAGE_WAHA_URL=http://127.0.0.1:4000
KAGE_WA_HOOK_HOST=0.0.0.0
KAGE_WA_HOOK_PORT=4001
KAGE_COMMANDS=/lookup=/work/lookup.mjs,/other=/work/other.mjs
SLACK_APP_TOKEN=xapp-test-fake
SLACK_USER_TOKEN=xoxp-test-fake
SLACK_BOT_TOKEN=xoxb-test-fake
KAGE_AWS_ACCESS_KEY_ID=AKIATESTFAKE
KAGE_AWS_SECRET_ACCESS_KEY=fake-secret-value
KAGE_VOICE_TOKEN=voice-fake
KAGE_GITHUB_SECRET=gh-fake
KAGE_MEETING_TOKEN=meet-fake
KAGE_BROWSER_TOKEN=browser-fake
JEV_API_KEY=jev-fake
`

describe('importing an env file', () => {
  test('every setting survives import then flatten, value for value', () => {
    const env = parseEnv(FULL)
    const { config, secrets } = fromEnv(env)
    assert.deepEqual(toEnv(config, secrets), env)
    // and as text, byte for byte once sorted
    const text = (e: Record<string, string>) => Object.entries(e).sort().map(([k, v]) => `${k}=${v}`).join('\n')
    assert.equal(text(toEnv(config, secrets)), text(env))
    assert.equal(config.unknown, undefined)
    Config.parse(JSON.parse(JSON.stringify(config)))
  })

  test('the fixture holds every setting the grep in docs/settings.md finds', () => {
    const found = execSync(`grep -rhoE 'KAGE_[A-Z_]+' --include=*.ts --include=*.sh . --exclude-dir=node_modules --exclude-dir=tests | sort -u`, { cwd: new URL('../..', import.meta.url), encoding: 'utf8' }).trim().split('\n')
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
