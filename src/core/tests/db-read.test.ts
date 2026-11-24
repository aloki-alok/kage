import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mayReadDb, readOnlyQuery } from '../db-read.ts'

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

describe('a function that acts outside the read-only transaction is refused', () => {
  test('another connection, another session, the server\'s files, its config and a long sleep', () => {
    for (const sql of ["select dblink_exec('dbname=x', 'delete from t')", "select * from dblink('dbname=x', 'select 1') as t(a int)",
      'select pg_terminate_backend(pid) from pg_stat_activity', 'select pg_cancel_backend(1)', "select pg_read_file('/etc/passwd')",
      "select pg_ls_dir('.')", "select lo_export(1, '/tmp/x')", 'select pg_reload_conf()', 'select pg_sleep(25)', "select set_config('a.b', 'c', false)",
      'select PG_TERMINATE_BACKEND (1)']) no(sql, /not allowed/)
  })
  test('a name that only contains one, or one inside a string, is fine', () => {
    ok("select 'pg_sleep(5)' as note")
    ok('select my_dblink_count from stats')
    ok('select pg_size_pretty(pg_total_relation_size(1))')
  })
})

describe('mayReadDb: which tasks may read the owner\'s named databases', () => {
  const task = (o: Record<string, unknown> = {}) => ({ fromOwner: false, meta: { channel: 'C1' }, ...o })
  test("the owner's and a teammate's Slack task, and an agent with an owner person", () => {
    assert.equal(mayReadDb(task({ fromOwner: true })), true)
    assert.equal(mayReadDb(task()), true)
    assert.equal(mayReadDb(task({ agent: { app: 'ATEST0001', person: 'U0TESTMATE1' } })), true)
    assert.equal(mayReadDb(task({ scheduled: true })), true)
  })
  test('a meeting transcript, a text, a call, an email, a WhatsApp chat, an agent with no person and a GitHub outsider read nothing', () => {
    assert.equal(mayReadDb(task({ source: 'meeting:abc' })), false)
    for (const channel of ['sms', 'voice', 'email', 'whatsapp']) assert.equal(mayReadDb(task({ meta: { channel } })), false, channel)
    assert.equal(mayReadDb(task({ agent: { app: 'ATEST0001' } })), false)
    assert.equal(mayReadDb(task({ outsider: 'someone' })), false)
  })
})
