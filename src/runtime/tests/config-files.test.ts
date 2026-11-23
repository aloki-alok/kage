import { describe, test } from 'node:test'
import { spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hasSettings, importLegacy, setKey, readSettings, sweepKeptCopies, syncWaha, tidyPeople, updateConfig, updateSecrets } from '../config-files.ts'

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
    assert.equal(readSettings(w.env).config.name, 'kagetest')
    assert.deepEqual(sweepKeptCopies(w.env, new Date('2026-11-22T10:15:01Z')), ['env.imported-20261114T090000Z', 'env.imported-20261114T101500Z'])
  })
  test('before the import, the env file reads the same as after, and nothing is written', () => {
    const w = world()
    const before = readSettings(w.env)
    assert.deepEqual(readdirSync(w.dir), ['env'])
    importLegacy(w.env)
    const after = readSettings(w.env)
    assert.deepEqual({ config: after.config, secrets: after.secrets, failed: after.failed() }, { config: before.config, secrets: before.secrets, failed: before.failed() })
  })
  test('with no settings at all, reading says to run setup', () => {
    const w = world('')
    assert.equal(hasSettings(w.env), false)
    assert.throws(() => readSettings(w.env), /kage setup/)
  })
})

describe('a config.json in the old teammate shape is rewritten once', () => {
  const OLD = { version: 1, people: { teammates: ['UTEST0001', 'UTEST0002'], trusted: ['UTEST0001'] }, connectors: { email: { on: true, teammateEmails: ['a@example.test', 'b@example.test'] } } }
  const oldWorld = (config: unknown = OLD) => {
    const w = world('')
    const file = join(w.dir, 'config.json')
    writeFileSync(file, JSON.stringify(config), { mode: 0o600 })
    return { ...w, file, before: readFileSync(file, 'utf8') }
  }
  const NOW = new Date('2026-11-23T08:00:00Z')
  test('it writes the one list, keeps the old file beside it at mode 600, and moves an email onto its Slack user', async () => {
    const w = oldWorld()
    const done = await tidyPeople(w.env, async e => (e === 'a@example.test' ? 'UTEST0002' : undefined), NOW)
    assert.deepEqual(done, { backup: 'config.json.before-tidy-20261123T080000Z', moved: [{ email: 'a@example.test', user: 'UTEST0002' }], unchecked: 0 })
    assert.equal(readFileSync(join(w.dir, done!.backup), 'utf8'), w.before)
    assert.equal(mode(join(w.dir, done!.backup)), 0o600)
    assert.deepEqual(JSON.parse(readFileSync(w.file, 'utf8')), { version: 1, people: { teammates: [{ user: 'UTEST0001', trusted: true }, { user: 'UTEST0002', email: 'a@example.test' }, { email: 'b@example.test' }] }, connectors: { email: { on: true } } })
    assert.equal(mode(w.file), 0o600)
  })
  test('a second start finds the clean shape and writes nothing', async () => {
    const w = oldWorld()
    await tidyPeople(w.env, async () => undefined, NOW)
    const after = readFileSync(w.file, 'utf8'), files = readdirSync(w.dir).sort()
    assert.equal(await tidyPeople(w.env, async () => 'UTEST0001', new Date('2026-11-24T08:00:00Z')), undefined)
    assert.equal(readFileSync(w.file, 'utf8'), after)
    assert.deepEqual(readdirSync(w.dir).sort(), files)
  })
  test('a failed Slack lookup still tidies the file, moves nothing, and counts the emails it could not check', async () => {
    const w = oldWorld()
    const done = await tidyPeople(w.env, async () => { throw new Error('missing_scope') }, NOW)
    assert.deepEqual(done?.moved, [])
    assert.equal(done?.unchecked, 2)
    assert.equal(JSON.parse(readFileSync(w.file, 'utf8')).people.teammates.length, 4)
  })
  test('a file the owner changed during the lookups is left alone until the next start', async () => {
    const w = oldWorld()
    const done = await tidyPeople(w.env, async () => { writeFileSync(w.file, JSON.stringify({ ...OLD, name: 'kagetest' })); return undefined }, NOW)
    assert.equal(done, undefined)
    assert.equal(JSON.parse(readFileSync(w.file, 'utf8')).name, 'kagetest')
    assert.deepEqual(readdirSync(w.dir), ['config.json'])
  })
  test('with no config.json there is nothing to tidy', async () => {
    assert.equal(await tidyPeople(world('').env, async () => undefined, NOW), undefined)
  })
})

describe('imported env files go after 7 days', () => {
  test('a kept config.json.before-tidy-* also goes after 7 days', () => {
    const w = world('')
    for (const t of ['20261101T000000Z', '20261110T000000Z']) writeFileSync(join(w.dir, `config.json.before-tidy-${t}`), 'x')
    assert.deepEqual(sweepKeptCopies(w.env, new Date('2026-11-14T00:00:00Z')), ['config.json.before-tidy-20261101T000000Z'])
  })
  test('only an env.imported-* older than 7 days is deleted', () => {
    const w = world('')
    for (const t of ['20261101T000000Z', '20261110T000000Z']) writeFileSync(`${w.env}.imported-${t}`, 'x')
    writeFileSync(join(w.dir, 'env.imported-notatime'), 'x')
    assert.deepEqual(sweepKeptCopies(w.env, new Date('2026-11-14T00:00:00Z')), ['env.imported-20261101T000000Z'])
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

describe('an install from before 0.4.0 keeps its own keys (a teammate lost a tool key this way)', () => {
  test('a key of the person\'s own in the old env file reaches the hub environment after the first-start import', async () => {
    const w = world(`${ENV}MY_TOOL_API_KEY=sk-test-1234567890abcdef\nMY_TOOL_URL=https://tool.test\n`)
    importLegacy(w.env, new Date('2026-11-14T10:15:00Z'))
    const raw = (f: string) => JSON.parse(readFileSync(join(w.dir, f), 'utf8'))
    const { unknownEnv } = await import('../../core/config.ts')
    const env = unknownEnv(raw('config.json'), raw('secrets.json'))
    assert.equal(env.MY_TOOL_API_KEY, 'sk-test-1234567890abcdef')
    assert.equal(env.MY_TOOL_URL, 'https://tool.test')
    assert.equal(env.SLACK_BOT_TOKEN, undefined, 'Kage\'s own tokens stay out')
  })
})

describe('a secret that names a command (#158)', () => {
  const commandWorld = () => {
    const w = world('')
    const count = join(w.dir, 'runs')
    writeFileSync(join(w.dir, 'config.json'), JSON.stringify({ version: 1 }))
    writeFileSync(join(w.dir, 'secrets.json'), JSON.stringify({
      slack: { app: 'xapp-plain', bot: { command: `echo run >> '${count}'; printf 'xoxb-%s\\n' from-command` } },
      jevKey: { command: 'echo leaked-$((40+2)) >&2; exit 3' },
      voiceToken: { command: 'true' },
    }), { mode: 0o600 })
    return { ...w, count }
  }

  test('readSettings runs a command only when its secret is read, once per process, failures included', () => {
    const w = commandWorld()
    const fails = join(w.dir, 'fails')
    writeFileSync(join(w.dir, 'secrets.json'), readFileSync(join(w.dir, 'secrets.json'), 'utf8').replace('echo leaked', `echo f >> '${fails}'; echo leaked`))
    const first = readSettings(w.env)
    assert.equal(first.config.version, 1)
    assert.equal(existsSync(w.count), false, 'reading the config runs no command')
    assert.equal(existsSync(fails), false, 'reading the config runs no command')
    assert.equal(first.secrets.slack?.bot, 'xoxb-from-command')
    assert.equal(first.secrets.slack?.app, 'xapp-plain')
    assert.deepEqual(first.failed().map(f => f.path), ['voiceToken', 'jevKey'])
    assert.equal(first.secrets.jevKey, undefined)
    assert.equal(readSettings(w.env).secrets.slack?.bot, 'xoxb-from-command')
    readSettings(w.env).failed()
    assert.equal(readFileSync(w.count, 'utf8'), 'run\n')
    assert.equal(readFileSync(fails, 'utf8'), 'f\n')
  })

  test("a command's stderr never reaches Kage's own output", () => {
    const w = commandWorld()
    const code = `import { readSettings } from ${JSON.stringify(new URL('../config-files.ts', import.meta.url).pathname)}; const s = readSettings(${JSON.stringify(w.env)}); s.secrets.jevKey; console.log(JSON.stringify(s.failed()))`
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8' })
    assert.match(r.stdout, /jevKey/)
    assert.doesNotMatch(r.stdout + r.stderr, /leaked-42/)
  })

  test('changing another secret keeps the command on disk, and never writes its output', () => {
    const w = commandWorld()
    updateSecrets(w.env, s => ({ ...s, browserToken: 'browser-fake' }))
    syncWaha(w.env)
    const disk = readFileSync(join(w.dir, 'secrets.json'), 'utf8')
    assert.match(disk, /"command": "echo run/)
    assert.doesNotMatch(disk, /xoxb-from-command/)
    assert.equal(JSON.parse(disk).browserToken, 'browser-fake')
  })
})
