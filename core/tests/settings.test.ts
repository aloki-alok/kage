import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { checkEnv, parseEnv } from '../settings.ts'

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
