import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readGate, readOnlyQuery, turnAskers } from '../db-read.ts'
import type { TrustLine } from '../trust.ts'

const ok = (sql: string) => {
  const r = readOnlyQuery(sql, 200)
  assert.ok('sql' in r, `refused ${JSON.stringify(sql)}: ${'refused' in r ? r.refused : ''}`)
  return r.sql
}
const no = (sql: string, why: RegExp) => {
  const r = readOnlyQuery(sql, 200)
  assert.ok('refused' in r, `allowed ${JSON.stringify(sql)}`)
  assert.match(r.refused, why)
}

describe('a single read runs, capped', () => {
  test('a plain select is wrapped in the row cap', () => {
    assert.equal(ok('select id from calls'), 'select * from (\nselect id from calls\n) as kage_db_read limit 200')
  })
  test('mixed case, a CTE and one trailing semicolon are fine', () => {
    ok('SeLeCt 1')
    ok('WITH recent AS (SELECT * FROM calls WHERE at > now() - interval \'1 day\') SELECT count(*) FROM recent;')
    ok('  select 1 ;  \n')
  })
  test('keywords inside strings, quoted names and comments are not code', () => {
    ok("select 'delete from users; drop table x' as note")
    ok('select "update", "drop" from audit')
    ok("select 'it''s; insert' as quote")
    ok('select 1 -- delete everything later\n')
    ok('select /* drop table x; */ 1')
    ok('select /* outer /* inner; delete */ still a comment; drop */ 1')
  })
  test('comments are taken out before the wrap, so a closing comment cannot eat the cap', () => {
    assert.equal(ok('select 1 -- note'), 'select * from (\nselect 1\n) as kage_db_read limit 200')
  })
  test('a word that only contains a keyword is fine', () => {
    ok('select updated_at, created_by, dropped, deleted_count from calls')
  })
})

describe('anything else is refused', () => {
  test('a write, as the first word or inside a CTE', () => {
    for (const w of ['insert into t values (1)', 'update t set a = 1', 'delete from t', 'alter table t add c int', 'drop table t',
      'create table t (a int)', 'grant all on t to x', 'truncate t', 'copy t to stdout', 'call p()', 'do $x$ begin end $x$'])
      no(w, /./)
    no('with gone as (delete from t returning *) select * from gone', /DELETE/)
    no('WITH x AS (select 1) INSERT INTO t select * from x', /INSERT/)
  })
  test('a second statement after a semicolon', () => {
    no('select 1; select 2', /one statement/)
    no("select 'a'; delete from t", /one statement/)
    no('select 1;;', /one statement/)
  })
  test('row locks and select into', () => {
    no('select * from t for update', /UPDATE/)
    no('select * from t FOR SHARE', /row lock/)
    no('select * from t for no key update', /UPDATE/)
    no('select * into newtable from t', /INTO/)
  })
  test('only select and with may start it', () => {
    no('explain analyze delete from t', /SELECT or WITH/)
    no('show all', /SELECT or WITH/)
    no('', /empty/)
    no('-- just a comment', /empty/)
  })
  test('a backslash anywhere: psql would run it as a command, and string escapes are read two ways', () => {
    no('select 1 \\! rm -rf ~', /backslash/)
    no("select E'\\'' ; delete from t; --'", /backslash/)
    no("select 'a\\' ; delete from t; -- '", /backslash/)
  })
  test('dollar quotes are refused, since a dollar can also sit inside a name', () => {
    no('select $$; delete from t; $$', /dollar/)
    no('select 1 as x$a$; delete from t; select 1 as y$a$', /dollar/)
    no("select $é$ ' $é$ ) as t; with d as (delete from t returning *) select * from d, (select 1 -- '", /dollar/)
    ok('select * from t where id = $1')
  })
  test('an unclosed string or comment', () => {
    no("select 'open", /unclosed/)
    no('select /* open', /unclosed/)
    no('select "open', /unclosed/)
  })
})

describe('who may read a named route', () => {
  const line = (o: Partial<TrustLine> = {}): TrustLine => ({ id: 'T1', who: 'U0TEST1', kind: 'prod-read', reach: 'prod', answer: 'yes', once: false, link: 'l', at: '2026-11-25T00:00:00.000Z', state: 'live', ...o })
  const mate = (teammate = 'U0TEST1') => ({ reader: true, owner: false, teammate })
  const gate = (o: Partial<Parameters<typeof readGate>[0]> = {}) => readGate({ turn: [mate()], owner: false, route: 'prod', mode: 'on', lines: [line()], ...o })
  test('the owner reads in every mode, a covered teammate only in on mode', () => {
    for (const mode of ['off', 'shadow', 'on'] as const) assert.equal(gate({ owner: true, turn: [{ reader: true, owner: true }], mode, lines: [] }).read, true, mode)
    assert.deepEqual(gate(), { read: true, steps: [{ who: 'U0TEST1', line: 'T1' }], would: 'go' })
    assert.equal(gate({ mode: 'shadow' }).read, false)
    assert.equal(gate({ mode: 'off' }).read, false)
  })
  test('a line covers one teammate and one route, and a no wins', () => {
    assert.equal(gate({ route: 'reports' }).read, false)
    assert.equal(gate({ turn: [mate('U0TEST2')] }).read, false)
    assert.match((gate({ lines: [line(), line({ id: 'T2', answer: 'no' })] }) as { why: string }).why, /said no/)
    assert.equal(gate({ lines: [line({ once: true })] }).read, false)
  })
  test('every teammate in the turn needs a line, in any order, and an owner task in the turn adds none', () => {
    const lines = [line(), line({ id: 'T2', who: 'U0TEST2' })]
    assert.equal(gate({ turn: [mate(), mate('U0TEST2')], lines }).read, true)
    assert.equal(gate({ turn: [mate('U0TEST3'), mate()], lines }).read, false)
    assert.equal(gate({ turn: [mate(), mate('U0TEST3')], lines }).read, false)
    assert.equal(gate({ turn: [mate(), { reader: true, owner: true }] }).read, true)
    assert.equal(gate({ turn: [mate(), { reader: false, owner: false, teammate: 'U0TEST1' }] }).read, false)
  })
  test('a route the owner opened to teammates reads with no line, in every mode', () => {
    for (const mode of ['off', 'shadow', 'on'] as const) assert.equal(gate({ open: true, mode, lines: [] }).read, true, mode)
    assert.equal(gate({ open: true, turn: [mate(), mate('U0TEST2')], lines: [] }).read, true)
    assert.equal(gate({ open: false, lines: [] }).read, false)
  })
  test('an open route still says no to a teammate the owner said no to, and to anyone not a listed teammate', () => {
    assert.match((gate({ open: true, mode: 'off', lines: [line({ answer: 'no' })] }) as { why: string }).why, /said no/)
    assert.equal(gate({ open: true, turn: [{ reader: true, owner: false }], lines: [] }).read, false)
    assert.equal(gate({ open: true, turn: [mate(), { reader: false, owner: false, teammate: 'U0TEST1' }], lines: [] }).read, false)
  })
  test('a kind that never learns covers nothing', () => {
    assert.equal(gate({ lines: [line({ kind: 'ssm-relay' })] }).read, false)
    assert.equal(gate({ lines: [line({ kind: 'prod-shell' })] }).read, false)
  })
  test('a turn with a non-reader, an empty turn and an unknown asker read nothing', () => {
    assert.equal(gate({ turn: [{ reader: false, owner: true }], owner: true }).read, false)
    assert.equal(gate({ turn: [] }).read, false)
    assert.equal(gate({ turn: [{ reader: true, owner: false }] }).read, false)
  })
  test('a meeting, an outsider, any bot, a text and the owner\'s DM job read nothing', () => {
    const t = { fromOwner: false, content: 'Teammate task (U0TEST1, Sam, not the owner): x', meta: { channel: 'C0TEST1' } }
    const readers = (x: object, dm = '') => turnAskers([{ ...t, ...x }], dm)[0]!
    assert.deepEqual(readers({}), { reader: true, owner: false, teammate: 'U0TEST1' })
    assert.equal(readers({ source: 'meeting:x' }).reader, false)
    assert.equal(readers({ outsider: 'x' }).reader, false)
    assert.equal(readers({ agent: { app: 'A0TEST1' } }).reader, false)
    assert.equal(readers({ agent: { app: 'A0TEST1', person: 'U0TEST1' } }).reader, false)
    assert.equal(readers({ meta: { channel: 'sms' } }).reader, false)
    assert.equal(readers({ meta: { channel: 'D0TEST1' } }, 'D0TEST1').reader, false)
    assert.equal(readers({ fromOwner: true, content: 'Task from Sam: x', meta: { channel: 'D0TEST1' } }, 'D0TEST1').reader, true)
  })
})
