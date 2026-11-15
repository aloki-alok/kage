import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hasSettings, importLegacy, setKey, readSettings, sweepImported, syncWaha, updateConfig, updateSecrets } from '../config-files.ts'

const ENV = 'KAGE_NAME=kagetest\nKAGE_MAX_SESSIONS=6\nKAGE_TEAMMATES=UTEST0001\nSLACK_APP_TOKEN=xapp-fake\nSLACK_USER_TOKEN=xoxp-fake\nSLACK_BOT_TOKEN=xoxb-fake\nKAGE_ODD_TOKEN=xoxb-secret-fake\n'
const world = (text = ENV) => {
  const dir = mkdtempSync(join(tmpdir(), 'kage-conf-'))
  const env = join(dir, 'env')
  if (text) writeFileSync(env, text, { mode: 0o600 })
  return { dir, env }
}
const mode = (f: string) => statSync(f).mode & 0o777

describe('the first start imports the env file', () => {
  test('it writes both files at mode 600 and renames the env file with the time', () => {
    const w = world()
    const to = importLegacy(w.env, new Date('2026-11-14T10:15:00Z'))
    assert.equal(to, `${w.env}.imported-20261114T101500Z`)
    assert.ok(!existsSync(w.env))
    assert.equal(mode(join(w.dir, 'config.json')), 0o600)
    assert.equal(mode(join(w.dir, 'secrets.json')), 0o600)
    const config = readFileSync(join(w.dir, 'config.json'), 'utf8')
    assert.ok(!config.includes('xox'), 'no token in config.json')
    assert.deepEqual(JSON.parse(config).unknown, { KAGE_ODD_TOKEN: null })
    assert.equal(JSON.parse(readFileSync(join(w.dir, 'secrets.json'), 'utf8')).slack.bot, 'xoxb-fake')
    assert.equal(readSettings(w.env).config.harness?.maxSessions, 6)
  })
  test('a second start does nothing, and a config.json that exists is never overwritten', () => {
    const w = world()
    importLegacy(w.env)
    assert.equal(importLegacy(w.env), undefined)
    assert.equal(readSettings(w.env).config.name, 'kagetest')
  })
  test('a plaintext env left by a crash after config.json was written is renamed, so the sweep deletes it', () => {
    const w = world()
    importLegacy(w.env, new Date('2026-11-14T09:00:00Z'))
    writeFileSync(w.env, 'KAGE_NAME=other\nSLACK_BOT_TOKEN=xoxb-fake\n')
    const to = importLegacy(w.env, new Date('2026-11-14T10:15:00Z'))
    assert.equal(to, `${w.env}.imported-20261114T101500Z`)
    assert.ok(!existsSync(w.env))
    assert.equal(readSettings(w.env).config.name, 'kagetest')   // config.json still wins
    assert.deepEqual(sweepImported(w.env, new Date('2026-11-22T10:15:01Z')), ['env.imported-20261114T090000Z', 'env.imported-20261114T101500Z'])
  })
  test('before the import, the env file reads the same as after, and nothing is written', () => {
    const w = world()
    const before = readSettings(w.env)
    assert.deepEqual(readdirSync(w.dir), ['env'])
    importLegacy(w.env)
    assert.deepEqual(readSettings(w.env), before)
  })
  test('with no settings at all, reading says to run setup', () => {
    const w = world('')
    assert.equal(hasSettings(w.env), false)
    assert.throws(() => readSettings(w.env), /kage setup/)
  })
})

describe('imported env files go after 7 days', () => {
  test('only an env.imported-* older than 7 days is deleted', () => {
    const w = world('')
    for (const t of ['20261101T000000Z', '20261110T000000Z']) writeFileSync(`${w.env}.imported-${t}`, 'x')
    writeFileSync(join(w.dir, 'env.imported-notatime'), 'x')
    assert.deepEqual(sweepImported(w.env, new Date('2026-11-14T00:00:00Z')), ['env.imported-20261101T000000Z'])
    assert.deepEqual(readdirSync(w.dir).sort(), ['env.imported-20261110T000000Z', 'env.imported-notatime'])
  })
})

describe('changing the files', () => {
  test('a change goes in after the import, so an env file waiting is not lost', () => {
    const w = world()
    updateConfig(w.env, c => ({ ...c, harness: { ...c.harness, maxSessions: 9 } }))
    updateSecrets(w.env, s => ({ ...s, browserToken: 'browser-fake' }))
    const { config, secrets } = readSettings(w.env)
    assert.equal(config.harness?.maxSessions, 9)
    assert.equal(secrets.browserToken, 'browser-fake')
    assert.equal(secrets.slack?.bot, 'xoxb-fake')
    assert.equal(mode(join(w.dir, 'secrets.json')), 0o600)
  })
  test('a token pasted into the teammates list is refused by its place, and its text never reaches the message', () => {
    const w = world('')
    writeFileSync(join(w.dir, 'config.json'), JSON.stringify({ version: 1, people: { teammates: ['UTEST0001', 'xoxp-0000-pasted-on-the-wrong-line'] } }))
    let msg = ''
    try { readSettings(w.env) } catch (e) { msg = (e as Error).message }
    assert.match(msg, /people\.teammates\.1/)
    assert.ok(!msg.includes('xoxp-0000'))
  })
  test('a bad config.json is refused with the key named and no value in the message', () => {
    const w = world('')
    writeFileSync(join(w.dir, 'config.json'), JSON.stringify({ version: 1, harness: { maxSesion: 'xoxb-fake-value' } }))
    let msg = ''
    try { readSettings(w.env) } catch (e) { msg = (e as Error).message }
    assert.match(msg, /config\.json.*maxSesion/)
    assert.ok(!msg.includes('xoxb-fake-value'))
  })
})

describe('a file that is not JSON', () => {
  test('says the line only, never the text, so a token in it cannot reach the log or a DM', () => {
    for (const bad of ['{\n  "slack": { "bot": "xoxb-fake-leak" \n  "x": 1 }\n', 'xoxb-fake-leak', '{"a": xoxb-fake-leak}']) {
      const w = world('')
      writeFileSync(join(w.dir, 'config.json'), bad)
      let msg = ''
      try { readSettings(w.env) } catch (e) { msg = (e as Error).message }
      assert.match(msg, /^config\.json: not valid JSON( at line \d+)?$/, msg)
      assert.ok(!msg.includes('leak') && !msg.includes('xox'), msg)
    }
  })
})

describe('a change that breaks the schema', () => {
  test('is refused with the key named, and the file stays as it was', () => {
    const w = world()
    importLegacy(w.env)
    const before = readFileSync(join(w.dir, 'config.json'), 'utf8')
    assert.throws(() => updateConfig(w.env, c => ({ ...c, harness: { maxSesion: 6 } }) as never), /config\.json.*maxSesion/)
    assert.equal(readFileSync(join(w.dir, 'config.json'), 'utf8'), before)
  })
})

describe('a session may not change the settings by this code either', () => {
  test('with KAGE_SESSION set (kept in every session, unlike KAGE_THREAD), a change is refused and the files stay as they were', () => {
    const w = world()
    importLegacy(w.env)
    const before = readFileSync(join(w.dir, 'config.json'), 'utf8')
    for (const marker of ['KAGE_SESSION', 'KAGE_THREAD']) {
      process.env[marker] = '1'
      try {
        assert.throws(() => updateConfig(w.env, c => ({ ...c, name: 'x' })), /terminal/)
        assert.throws(() => updateSecrets(w.env, s => ({ ...s, browserToken: 'x' })), /terminal/)
        assert.throws(() => setKey(w.env, 'afk.model', 'sonnet'), /terminal/)
      } finally { delete process.env[marker] }
    }
    assert.equal(readFileSync(join(w.dir, 'config.json'), 'utf8'), before)
  })
})

describe('a retired setting', () => {
  test('harness.unsandboxedCommands is dropped on read with one log line, so an old config.json still loads', (t) => {
    const w = world('')
    writeFileSync(join(w.dir, 'config.json'), JSON.stringify({ version: 1, name: 'kagetest', harness: { maxSessions: 4, unsandboxedCommands: ['ssh myhost *'] } }))
    const lines: string[] = []
    t.mock.method(process.stderr, 'write', (s: string) => { lines.push(String(s)); return true })
    const { config } = readSettings(w.env)
    assert.deepEqual(config.harness, { maxSessions: 4 })
    assert.equal(config.name, 'kagetest')
    assert.equal(lines.filter(l => l.includes('harness.unsandboxedCommands')).length, 1)
  })
  test('a typo still fails, and a config with no retired key is untouched', () => {
    const w = world('')
    writeFileSync(join(w.dir, 'config.json'), JSON.stringify({ version: 1, harness: { maxSesion: 4 } }))
    assert.throws(() => readSettings(w.env), /maxSesion/)
  })
})

describe('the WhatsApp container keys live in secrets.json', () => {
  test('a hand-made waha/.env moves in once, then secrets.json is the source and waha/.env is written from it', () => {
    const w = world(); importLegacy(w.env)
    const file = join(w.dir, 'waha', '.env')
    mkdirSync(join(w.dir, 'waha'))
    writeFileSync(file, 'WAHA_API_KEY=k1\nWHATSAPP_HOOK_HMAC_KEY=h1\n', { mode: 0o600 })
    assert.equal(syncWaha(w.env), false, 'the import changes nothing the container reads')
    assert.deepEqual(readSettings(w.env).secrets.waha, { WAHA_API_KEY: 'k1', WHATSAPP_HOOK_HMAC_KEY: 'h1' })
    updateSecrets(w.env, s => ({ ...s, waha: { WAHA_API_KEY: 'k2', WHATSAPP_HOOK_HMAC_KEY: 'h1' } }))
    assert.equal(syncWaha(w.env), true, 'a changed key rewrites the file')
    assert.equal(readFileSync(file, 'utf8'), 'WAHA_API_KEY=k2\nWHATSAPP_HOOK_HMAC_KEY=h1\n')
    assert.equal(mode(file), 0o600)
    assert.equal(syncWaha(w.env), false, 'the same keys leave the file alone')
  })

  test('with no WhatsApp at all, nothing is written', () => {
    const w = world(); importLegacy(w.env)
    assert.equal(syncWaha(w.env), false)
    assert.ok(!existsSync(join(w.dir, 'waha')))
    assert.equal(readSettings(w.env).secrets.waha, undefined)
  })
})
