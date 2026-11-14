import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { checkEnv, parseEnv, reloader } from '../settings.ts'

const FILE = 'KAGE_NAME=kage\nSLACK_APP_TOKEN=xapp-test\nSLACK_USER_TOKEN=xoxp-test\nSLACK_BOT_TOKEN=xoxb-test\nKAGE_TEAMMATES=UTEST0001\n'

describe('reading the env file', () => {
  test('quotes, indent and spaces around = are dropped, and the last line of a name wins', () => {
    assert.deepEqual(parseEnv('  KAGE_NAME = "kage"\nKAGE_AFK=on\nKAGE_AFK=off\n# a note\n'), { KAGE_NAME: 'kage', KAGE_AFK: 'off' })
  })
  test('a good file gives the name and both lists', () => {
    assert.deepEqual(checkEnv(parseEnv(FILE + 'KAGE_TRUSTED_APPS=ATEST0001, ATEST0002\n')), { name: 'kage', teammates: ['UTEST0001'], apps: ['ATEST0001', 'ATEST0002'] })
  })
  test('a bad entry is refused, and the reason quotes the entry', () => {
    const bad = (line: string) => (checkEnv(parseEnv(FILE + line)) as { error: string }).error
    assert.match(bad('KAGE_TEAMMATES=UTEST0001,priya\n'), /KAGE_TEAMMATES.*"priya"/)
    assert.match(bad('KAGE_TRUSTED_APPS=UTEST0001\n'), /KAGE_TRUSTED_APPS.*"UTEST0001"/)
    assert.match(bad('KAGE_NAME=Not A Name\n'), /KAGE_NAME/)
  })
  test('an agent in the app list may name its owner, a person or another agent', () => {
    const ok = checkEnv(parseEnv(FILE + 'KAGE_TRUSTED_APPS=ATEST0001:UTEST0001,ATEST0002:ATEST0001,ATEST0009\n')) as { apps: string[] }
    assert.deepEqual(ok.apps, ['ATEST0001:UTEST0001', 'ATEST0002:ATEST0001', 'ATEST0009'])
    assert.match((checkEnv(parseEnv(FILE + 'KAGE_TRUSTED_APPS=ATEST0001:priya\n')) as { error: string }).error, /KAGE_TRUSTED_APPS.*"ATEST0001:priya"/)
  })
  test('a long wrong entry may be a token on the wrong line: the reason names its place, never its text', () => {
    const r = (checkEnv(parseEnv(FILE + 'KAGE_TEAMMATES=UTEST0001,xoxp-0000-pasted-on-the-wrong-line\n')) as { error: string }).error
    assert.match(r, /KAGE_TEAMMATES.*entry 2/)
    assert.ok(!r.includes('xoxp-0000'))
    const a = (checkEnv(parseEnv(FILE + 'KAGE_TRUSTED_APPS=xoxb-0000-pasted-on-the-wrong-line\n')) as { error: string }).error
    assert.match(a, /KAGE_TRUSTED_APPS.*entry 1/)
    assert.ok(!a.includes('xoxb-0000'))
  })
  test('a missing token is refused by its name', () => {
    assert.match((checkEnv(parseEnv('KAGE_NAME=kage\nSLACK_APP_TOKEN=xapp-test\nSLACK_BOT_TOKEN=xoxb-test\n')) as { error: string }).error, /SLACK_USER_TOKEN/)
  })
})

describe('kage reload', () => {
  const hub = (file: { text: string }) => {
    const applied: { teammates: string[]; apps: string[] }[] = []
    const logged: string[] = []
    const reload = reloader({ boot: parseEnv(FILE), read: () => file.text, apply: l => applied.push(l), log: l => logged.push(l) })
    return { applied, logged, reload }
  }
  test('a changed list is applied and named, with what was added and removed', () => {
    const file = { text: FILE.replace('UTEST0001', 'UTEST0002,UTEST0003') + 'KAGE_TRUSTED_APPS=ATEST0001\n' }
    const h = hub(file)
    assert.deepEqual(h.reload(), {
      changed: ['KAGE_TEAMMATES: added UTEST0002, UTEST0003, removed UTEST0001', 'KAGE_TRUSTED_APPS: added ATEST0001'],
      restart: [], count: 1,
    })
    assert.deepEqual(h.applied, [{ teammates: ['UTEST0002', 'UTEST0003'], apps: ['ATEST0001'] }])
  })
  test('a bad file keeps the old settings and says why', () => {
    const file = { text: FILE + 'KAGE_TEAMMATES=priya\n' }
    const h = hub(file)
    const r = h.reload() as { refused: string }
    assert.match(r.refused, /"priya"/)
    assert.deepEqual(h.applied, [])
    // Once the line is fixed, the same hub takes the file.
    file.text = FILE + 'KAGE_TEAMMATES=UTEST0009\n'
    assert.deepEqual(h.reload(), { changed: ['KAGE_TEAMMATES: added UTEST0009, removed UTEST0001'], restart: [], count: 2 })
    assert.deepEqual(h.applied, [{ teammates: ['UTEST0009'], apps: [] }])
  })
  test('a file that cannot be read keeps the old settings', () => {
    const h = hub({ get text(): string { throw new Error('ENOENT: no such file') } })
    assert.match((h.reload() as { refused: string }).refused, /ENOENT/)
    assert.deepEqual(h.applied, [])
  })
  test('any other changed setting is named as needing a restart, and stays named until the restart', () => {
    const file = { text: FILE.replace('xoxb-test', 'xoxb-other') + 'KAGE_MAX_SESSIONS=8\n' }
    const h = hub(file)
    assert.deepEqual(h.reload(), { changed: [], restart: ['KAGE_MAX_SESSIONS', 'SLACK_BOT_TOKEN'], count: 1 })
    assert.deepEqual(h.reload(), { changed: [], restart: ['KAGE_MAX_SESSIONS', 'SLACK_BOT_TOKEN'], count: 2 })
    // A removed setting changed too.
    file.text = FILE.replace('KAGE_NAME=kage\n', '')
    assert.deepEqual(h.reload(), { changed: [], restart: ['KAGE_NAME'], count: 3 })
  })
  test('a list changed twice is compared with what the hub runs now, not with the start', () => {
    const file = { text: FILE + 'KAGE_TEAMMATES=UTEST0001,UTEST0002\n' }
    const h = hub(file)
    h.reload()
    assert.deepEqual(h.reload(), { changed: [], restart: [], count: 2 })
    file.text = FILE
    assert.deepEqual(h.reload(), { changed: ['KAGE_TEAMMATES: removed UTEST0002'], restart: [], count: 3 })
  })
  test('each reload is logged with its count, and no setting value reaches the log', () => {
    const file = { text: FILE.replace('xoxb-test', 'xoxb-secret') + 'KAGE_TEAMMATES=priya\n' }
    const h = hub(file)
    h.reload()
    file.text = FILE.replace('xoxb-test', 'xoxb-secret')
    h.reload()
    assert.equal(h.logged.length, 2)
    assert.match(h.logged[0]!, /^reload 1 refused: /)
    assert.match(h.logged[1]!, /^reload 2: .*needs a restart: SLACK_BOT_TOKEN/)
    assert.ok(!h.logged.join('\n').includes('xoxb-secret'))
  })
})
