import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { importLegacy, readSettings, updateConfig, updateSecrets } from '../config-files.ts'
import { configWatcher, type ConfigEvent } from '../config-watch.ts'

const ENV = 'KAGE_NAME=kagetest\nKAGE_TEAMMATES=UTEST0001\nSLACK_APP_TOKEN=xapp-fake\nSLACK_USER_TOKEN=xoxp-fake\nSLACK_BOT_TOKEN=xoxb-fake\n'
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'kage-watch-'))
  const env = join(dir, 'env')
  writeFileSync(env, ENV, { mode: 0o600 })
  importLegacy(env)
  const seen = { applied: [] as unknown[], events: [] as [ConfigEvent, string[]][], told: [] as string[], restart: [] as boolean[], log: [] as string[] }
  // Resolves on the first live apply, so a test waits on the watcher's own event and not on a clock.
  let appliedOnce!: () => void
  const applied = new Promise<void>(r => { appliedOnce = r })
  const w = configWatcher({
    envFile: env, boot: readSettings(env), log: l => seen.log.push(l), apply: l => { seen.applied.push(l); appliedOnce() },
    event: (k, keys) => seen.events.push([k, keys]), tell: t => seen.told.push(t), restartWanted: y => seen.restart.push(y), debounceMs: 20,
  })
  return { dir, env, w, seen, applied }
}

describe('a changed people list applies now', () => {
  test('it is applied, logged as config.live with the key name, and no restart is asked', () => {
    const t = setup()
    updateConfig(t.env, c => ({ ...c, people: { teammates: ['UTEST0001', 'UTEST0002'], agents: [] } }))
    const r = t.w.check()
    assert.deepEqual(r, { changed: ['people.teammates: added UTEST0002'], restart: [], count: 1 })
    assert.deepEqual(t.seen.applied, [{ teammates: ['UTEST0001', 'UTEST0002'], apps: [] }])
    assert.deepEqual(t.seen.events, [['config.live', ['people.teammates']]])
    assert.deepEqual(t.seen.restart, [])
    updateConfig(t.env, c => ({ ...c, people: { teammates: ['UTEST0002'], agents: [] } }))
    assert.deepEqual((t.w.check() as { changed: string[] }).changed, ['people.teammates: removed UTEST0001'])
    assert.ok(!t.seen.log.join('\n').includes('xox'), 'no token in the log')
    t.w.close()
  })
})

describe('any other key restarts the hub once it is quiet', () => {
  test('a restart key asks for a restart, and putting it back withdraws the ask', () => {
    const t = setup()
    updateConfig(t.env, c => ({ ...c, harness: { maxSessions: 9 } }))
    updateSecrets(t.env, s => ({ ...s, slack: { ...s.slack, bot: 'xoxb-other-fake' } }))
    assert.deepEqual((t.w.check() as { restart: string[] }).restart, ['harness.maxSessions', 'secrets.slack.bot'])
    assert.deepEqual(t.seen.restart, [true])
    assert.deepEqual(t.seen.events, [['config.restart', ['harness.maxSessions', 'secrets.slack.bot']]])
    assert.deepEqual(t.seen.applied, [])
    t.w.check()
    assert.deepEqual(t.seen.restart, [true], 'the same ask is not repeated')
    updateConfig(t.env, c => ({ ...c, harness: undefined }))
    updateSecrets(t.env, s => ({ ...s, slack: { ...s.slack, bot: 'xoxb-fake' } }))
    t.w.check()
    assert.deepEqual(t.seen.restart, [true, false])
    assert.ok(!JSON.stringify(t.seen.events).includes('xox'), 'no value in an event')
    t.w.close()
  })
})

describe('a wrong file is refused', () => {
  test('the last good settings stay, the owner hears once, and the event names the key only', () => {
    const t = setup()
    writeFileSync(join(t.dir, 'config.json'), JSON.stringify({ version: 1, harness: { maxSesion: 'xoxb-fake-value' } }))
    const r = t.w.check() as { refused: string }
    assert.match(r.refused, /maxSesion/)
    t.w.check()
    assert.equal(t.seen.told.length, 1)
    assert.ok(!t.seen.told[0]!.includes('xoxb-fake-value'))
    assert.deepEqual(t.seen.events[0], ['config.refused', ['harness.maxSesion']])
    assert.deepEqual(t.seen.applied, [])
    // Fixed: the next good file is taken, and a later bad one tells the owner again.
    writeFileSync(join(t.dir, 'config.json'), JSON.stringify({ version: 1, name: 'kagetest', people: { teammates: ['UTEST0001'] } }))
    assert.ok('changed' in t.w.check())
    writeFileSync(join(t.dir, 'config.json'), '{ not json')
    t.w.check()
    assert.equal(t.seen.told.length, 2)
    t.w.close()
  })
})

describe('a schema-valid value the hub cannot run on is refused too', () => {
  test('a quote in a path, a bad port or a missing cwd leaves the last good settings and asks for no restart', () => {
    const t = setup()
    for (const bad of [{ harness: { memory: "/tmp/it's" } }, { connectors: { voice: { port: 99999 } } }, { harness: { cwd: join(t.dir, 'nope') } }]) {
      updateConfig(t.env, c => ({ ...c, harness: undefined, connectors: undefined, ...bad }))
      assert.match((t.w.check() as { refused: string }).refused, /memory|port|cwd/)
    }
    assert.deepEqual(t.seen.restart, [])
    assert.equal(t.seen.told.length, 3)
    t.w.close()
  })
})

describe('the watcher itself', () => {
  test('a write to config.json is checked by itself, with no call', { timeout: 20_000 }, async () => {
    const t = setup()
    updateConfig(t.env, c => ({ ...c, people: { teammates: ['UTEST0001', 'UTEST0003'], agents: [] } }))
    await t.applied
    assert.deepEqual(t.seen.applied, [{ teammates: ['UTEST0001', 'UTEST0003'], apps: [] }])
    t.w.close()
  })

  test('a new browser token (kage add browser) asks for the quiet restart, and no value is logged', () => {
    const t = setup()
    updateSecrets(t.env, s => ({ ...s, browserToken: 'browser-token-fake' }))
    assert.deepEqual((t.w.check() as { restart: string[] }).restart, ['secrets.browserToken'])
    assert.deepEqual(t.seen.restart, [true])
    assert.ok(!JSON.stringify([t.seen.events, t.seen.log]).includes('browser-token-fake'))
    t.w.close()
  })
})
