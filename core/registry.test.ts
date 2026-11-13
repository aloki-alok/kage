import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { add, appEntry, kindOf, listIn, ownerPerson, registryIn, remove, validAppId, withList, withRegistry, type Entry } from './registry.ts'

const person = (id: string): Entry => ({ kind: 'person', id })
const agent = (id: string, owner?: string): Entry => ({ kind: 'agent', id, ...(owner && { owner }) })

describe('a comma separated list in the env file', () => {
  const T = 'KAGE_TEAMMATES'
  const env = 'KAGE_NAME=kage\nSLACK_BOT_TOKEN=xoxb-1\nKAGE_TEAMMATES=U1,U2\n'
  test('adding keeps every other line and skips a duplicate', () => {
    assert.equal(withList(env, T, ['U1', 'U2', 'U3']), 'KAGE_NAME=kage\nSLACK_BOT_TOKEN=xoxb-1\nKAGE_TEAMMATES=U1,U2,U3\n')
    assert.deepEqual(listIn(withList(env, T, ['U1', 'U2', 'U2']), T), ['U1', 'U2'])
  })
  test('a quoted or indented line is read and replaced, blank lines kept', () => {
    const quoted = 'KAGE_NAME=kage\n\n  KAGE_TEAMMATES="U1,U2"\n'
    assert.deepEqual(listIn(quoted, T), ['U1', 'U2'])
    assert.equal(withList(quoted, T, ['U1']), 'KAGE_NAME=kage\n\nKAGE_TEAMMATES=U1\n')
  })
  test('the first id adds the line; removing the last drops it', () => {
    assert.equal(withList('KAGE_NAME=kage\n', T, ['U9']), 'KAGE_NAME=kage\nKAGE_TEAMMATES=U9\n')
    assert.equal(withList(env, T, []), 'KAGE_NAME=kage\nSLACK_BOT_TOKEN=xoxb-1\n')
  })
  test('one list leaves the other alone', () => {
    const next = withList(env, 'KAGE_TRUSTED_APPS', ['ATEST0001'])
    assert.equal(next, env + 'KAGE_TRUSTED_APPS=ATEST0001\n')
    assert.deepEqual(listIn(next, T), ['U1', 'U2'])
    assert.equal(withList(next, 'KAGE_TRUSTED_APPS', []), env)
  })
  test('an app id is A, then capital letters and digits', () => {
    for (const id of ['ATEST0001', 'A0TEST']) assert.equal(validAppId(id), true, id)
    for (const id of ['', 'A', 'atest0001', 'UTEST0001', 'ATEST 001', 'ATEST0001,ATEST0002', 'ATEST0001\nSLACK_BOT_TOKEN=x']) assert.equal(validAppId(id), false, id)
  })
})

describe('the registry: people and agents, read from the two lists', () => {
  const env = 'KAGE_NAME=kage\nKAGE_TEAMMATES=UTEST0001,UTEST0002\nKAGE_TRUSTED_APPS=ATEST0001:UTEST0001,ATEST0002:ATEST0001,ATEST0009\n'
  const all = [person('UTEST0001'), person('UTEST0002'), agent('ATEST0001', 'UTEST0001'), agent('ATEST0002', 'ATEST0001'), agent('ATEST0009')]
  test('a person is an id; an agent is its app id, with its owner after a colon', () => {
    assert.deepEqual(registryIn(env), all)
  })
  test('writing it back gives the same two lines and keeps every other line', () => {
    assert.equal(withRegistry(env, all), env)
    assert.equal(withRegistry(env, []), 'KAGE_NAME=kage\n')
  })
  test('an entry in the app list is an app id, or an app id and an owner who is a person or an agent', () => {
    assert.deepEqual(appEntry('ATEST0001'), { id: 'ATEST0001' })
    assert.deepEqual(appEntry('ATEST0001:UTEST0001'), { id: 'ATEST0001', owner: 'UTEST0001' })
    assert.deepEqual(appEntry('ATEST0002:ATEST0001'), { id: 'ATEST0002', owner: 'ATEST0001' })
    for (const bad of ['', 'UTEST0001', 'ATEST0001:', 'ATEST0001:priya', 'ATEST0001:UTEST0001:UTEST0002:UTEST0003', ':UTEST0001', 'ATEST0001:ATEST0001']) assert.equal(appEntry(bad), undefined, bad)
  })
  test('an agent may carry its tag: the Slack user id that a mention of it uses', () => {
    assert.deepEqual(appEntry('ATEST0001:UTEST0001:UAGENT001'), { id: 'ATEST0001', owner: 'UTEST0001', tag: 'UAGENT001' })
    for (const bad of ['ATEST0001:UTEST0001:ATEST0002', 'ATEST0001:UTEST0001:', 'ATEST0001::UAGENT001', 'ATEST0001:UTEST0001:UAGENT001:x']) assert.equal(appEntry(bad), undefined, bad)
    const env = 'KAGE_TEAMMATES=UTEST0001\nKAGE_TRUSTED_APPS=ATEST0001:UTEST0001:UAGENT001\n'
    assert.deepEqual(registryIn(env), [person('UTEST0001'), { kind: 'agent', id: 'ATEST0001', owner: 'UTEST0001', tag: 'UAGENT001' }])
    assert.equal(withRegistry(env, registryIn(env)), env)
  })
  test('adding a listed agent again with its tag keeps the owner and saves the tag', () => {
    const base = [person('UTEST0001'), agent('ATEST0001', 'UTEST0001')]
    const tagged: Entry = { kind: 'agent', id: 'ATEST0001', owner: 'UTEST0001', tag: 'UAGENT001' }
    assert.deepEqual(add(base, tagged), { entries: [person('UTEST0001'), tagged], added: [tagged] })
    assert.deepEqual(add([person('UTEST0001'), tagged], tagged), { entries: [person('UTEST0001'), tagged], added: [] })
    // Added again by app id alone, it keeps the tag it had.
    assert.deepEqual(add([person('UTEST0001'), tagged], agent('ATEST0001', 'UTEST0001')), { entries: [person('UTEST0001'), tagged], added: [] })
  })
  test('an id says what it is', () => {
    assert.equal(kindOf('UTEST0001'), 'person')
    assert.equal(kindOf('WTEST0001'), 'person')
    assert.equal(kindOf('ATEST0001'), 'agent')
    assert.equal(kindOf('priya'), undefined)
  })
  test('the person an agent answers to is the top of its owner chain', () => {
    assert.equal(ownerPerson(all, 'ATEST0001'), 'UTEST0001')
    assert.equal(ownerPerson(all, 'ATEST0002'), 'UTEST0001')   // owned by a manager agent
    assert.equal(ownerPerson(all, 'ATEST0009'), undefined)     // listed before owners existed
    assert.equal(ownerPerson(all, 'ATEST0404'), undefined)
    // A loop made by hand in the file ends, with no person.
    assert.equal(ownerPerson([agent('ATEST0001', 'ATEST0002'), agent('ATEST0002', 'ATEST0001')], 'ATEST0001'), undefined)
    // An owner who is no longer listed is no owner.
    assert.equal(ownerPerson([agent('ATEST0001', 'UTEST0404')], 'ATEST0001'), undefined)
  })
})

describe('kage add', () => {
  test('a person is added once', () => {
    assert.deepEqual(add([], person('UTEST0001')), { entries: [person('UTEST0001')], added: [person('UTEST0001')] })
    assert.deepEqual(add([person('UTEST0001')], person('UTEST0001')), { entries: [person('UTEST0001')], added: [] })
  })
  test('adding an agent adds the person it is tied to', () => {
    assert.deepEqual(add([], agent('ATEST0001', 'UTEST0001')), {
      entries: [person('UTEST0001'), agent('ATEST0001', 'UTEST0001')],
      added: [person('UTEST0001'), agent('ATEST0001', 'UTEST0001')],
    })
  })
  test('an agent needs an owner', () => {
    assert.match((add([], agent('ATEST0001')) as { error: string }).error, /owner/)
  })
  test('an agent may be owned by a listed agent (its manager), never by one that is not listed', () => {
    const base = [person('UTEST0001'), agent('ATEST0001', 'UTEST0001')]
    assert.deepEqual(add(base, agent('ATEST0002', 'ATEST0001')), { entries: [...base, agent('ATEST0002', 'ATEST0001')], added: [agent('ATEST0002', 'ATEST0001')] })
    assert.match((add(base, agent('ATEST0002', 'ATEST0404')) as { error: string }).error, /ATEST0404 is not listed/)
    assert.match((add(base, agent('ATEST0002', 'ATEST0002')) as { error: string }).error, /cannot be its own owner/)
    // An agent with no owner (listed by hand before owners existed) cannot be a manager until it is tied to someone.
    const loose = [...base, agent('ATEST0009')]
    assert.match((add(loose, agent('ATEST0002', 'ATEST0009')) as { error: string }).error, /ATEST0009 has no owner itself/)
  })
  test('an agent listed again takes the new owner: it is tied to one owner', () => {
    const base = [person('UTEST0001'), agent('ATEST0001', 'UTEST0001')]
    assert.deepEqual(add(base, agent('ATEST0001', 'UTEST0002')), {
      entries: [person('UTEST0001'), person('UTEST0002'), agent('ATEST0001', 'UTEST0002')],
      added: [person('UTEST0002'), agent('ATEST0001', 'UTEST0002')],
    })
    assert.deepEqual(add(base, agent('ATEST0001', 'UTEST0001')), { entries: base, added: [] })
    // A manager cannot be moved under its own specialist.
    const chain = [...base, agent('ATEST0002', 'ATEST0001')]
    assert.match((add(chain, agent('ATEST0001', 'ATEST0002')) as { error: string }).error, /loop/)
  })
})

describe('kage remove', () => {
  const all = [person('UTEST0001'), person('UTEST0002'), agent('ATEST0001', 'UTEST0001'), agent('ATEST0002', 'ATEST0001'), agent('ATEST0003', 'UTEST0002'), agent('ATEST0009')]
  test('removing a person removes their agents, and the agents those own', () => {
    assert.deepEqual(remove(all, 'UTEST0001'), {
      entries: [person('UTEST0002'), agent('ATEST0003', 'UTEST0002'), agent('ATEST0009')],
      removed: [person('UTEST0001'), agent('ATEST0001', 'UTEST0001'), agent('ATEST0002', 'ATEST0001')],
    })
  })
  test('removing an agent keeps its person and removes the agents it owns', () => {
    assert.deepEqual(remove(all, 'ATEST0001').removed, [agent('ATEST0001', 'UTEST0001'), agent('ATEST0002', 'ATEST0001')])
    assert.deepEqual(remove(all, 'ATEST0002').removed, [agent('ATEST0002', 'ATEST0001')])
  })
  test('someone who is not listed removes nothing', () => {
    assert.deepEqual(remove(all, 'UTEST0404'), { entries: all, removed: [] })
  })
})

// Issue 49: a Kage session, whoever's task it runs, must not change who reaches Kage.
describe('kage add and kage remove inside a Kage session', () => {
  const cli = fileURLToPath(new URL('../cli/registry.ts', import.meta.url))
  const FILE = 'KAGE_NAME=kage\nKAGE_TEAMMATES=UTEST0001\n'
  const run = (args: string[], inKage: boolean) => {
    const file = join(mkdtempSync(join(tmpdir(), 'kage-registry-')), 'env')
    writeFileSync(file, FILE, { mode: 0o600 })
    const { KAGE_CLAUDE: _, ...clean } = process.env
    const r = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env: { ...clean, KAGE_ENV: file, ...(inKage && { KAGE_CLAUDE: 'claude --channels test' }) } })
    return { code: r.status, err: r.stderr, out: r.stdout, file: readFileSync(file, 'utf8') }
  }
  test('both refuse, say the owner runs them from a terminal, and leave the file as it was', () => {
    for (const args of [['add', 'UTEST0002'], ['remove', 'UTEST0001'], ['add', 'ATEST0001', 'UTEST0001']]) {
      const r = run(args, true)
      assert.equal(r.code, 1, args.join(' '))
      assert.match(r.err, /inside Kage.*owner runs kage (add|remove) in their own terminal/s)
      assert.equal(r.file, FILE)
    }
  })
  test('list still works there, and reads only ids', () => {
    const r = run(['list', '--ids'], true)
    assert.equal(r.code, 0)
    assert.match(r.out, /UTEST0001/)
  })
  test('the written file is private even when a readable copy was left behind', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'kage-registry-')), 'env')
    writeFileSync(file, FILE, { mode: 0o600 })
    writeFileSync(`${file}.new`, 'left by a crash', { mode: 0o644 })
    const { KAGE_CLAUDE: _, ...clean } = process.env
    const r = spawnSync(process.execPath, [cli, 'remove', 'UTEST0001'], { encoding: 'utf8', env: { ...clean, KAGE_ENV: file } })
    assert.equal(r.status, 0, r.stderr)
    assert.equal(readFileSync(file, 'utf8'), 'KAGE_NAME=kage\n')
    assert.equal(statSync(file).mode & 0o777, 0o600)
  })
  test('outside a session, removing by id needs no Slack and writes the file', () => {
    const r = run(['remove', 'UTEST0001'], false)
    assert.equal(r.code, 0, r.err)
    assert.equal(r.file, 'KAGE_NAME=kage\n')
  })
})
