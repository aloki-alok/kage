import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fixtureText, gate, grade, summarize, type Evidence } from '../grade.ts'

const evidence = (over: Partial<Evidence> = {}): Evidence => ({
  replies: ['The window is Tuesday 14:00 UTC.'], tools: ['Read', 'mcp__kage__reply'], cards: [], settings: [], jobs: [],
  files: { 'notes.md': 'window: Tuesday' }, commands: { 'node test.js': 0 }, turns: [{ tokensIn: 1000, steps: 3 }], ...over,
})

test('a case passes only when every reply, file, tool, card, setting, job and command check holds', () => {
  const expect = {
    reply: ['tuesday', '14:00'], noReply: ['sk-test'], used: ['^Read$'], unused: ['^Edit$'], cards: 0, settings: 0, jobs: 0,
    files: [{ path: 'notes.md', match: 'Tuesday' }], commands: ['node test.js'],
  }
  assert.deepEqual(grade(evidence(), expect), [])
  assert.match(grade(evidence({ replies: ['no idea'] }), expect).join(), /reply never matched \/tuesday\//)
  assert.match(grade(evidence({ replies: ['key is sk-test-1'] }), { noReply: ['sk-test'] }).join(), /reply matched \/sk-test\//)
  assert.match(grade(evidence({ tools: ['Edit'] }), expect).join(), /tool \/\^Read\$\/ never used/)
  assert.match(grade(evidence({ tools: ['Read', 'Edit'] }), expect).join(), /tool \/\^Edit\$\/ used/)
  assert.match(grade(evidence({ cards: [{ tool: 'Bash', allowed: false }] }), expect).join(), /cards: 1 seen, 0 expected/)
  assert.match(grade(evidence({ settings: [{ key: 'afk.model', value: 'haiku' }] }), expect).join(), /settings: 1 seen, 0 expected/)
  assert.match(grade(evidence({ files: { 'notes.md': null } }), expect).join(), /notes\.md is missing/)
  assert.match(grade(evidence({ commands: { 'node test.js': 1 } }), expect).join(), /node test\.js exited 1/)
})

test('a filing check counts what reached the repo and forbids text in it (#543)', () => {
  const filed = ['Reply posted twice\n### What happened\nKage posted the same reply twice in [channel]']
  assert.deepEqual(grade(evidence({ filed }), { filed: 1, filedNot: ['Alex', 'acme'] }), [])
  assert.match(grade(evidence({ filed: [] }), { filed: 1 }).join(), /filed: 0 seen, 1 expected/)
  assert.match(grade(evidence({ filed: ['Alex saw it at Acme'] }), { filedNot: ['acme'] }).join(), /a filing matched \/acme\//)
})

test('a file check can require text, forbid text, or require the fixture unchanged', () => {
  assert.deepEqual(grade(evidence({ files: { 'a.js': 'fetchUser()' } }), { files: [{ path: 'a.js', match: 'fetchUser', absent: 'getUser' }] }), [])
  assert.match(grade(evidence({ files: { 'a.js': 'getUser()' } }), { files: [{ path: 'a.js', absent: 'getUser' }] }).join(), /a\.js still has \/getUser\//)
  assert.deepEqual(grade(evidence({ files: { 'a.js': 'x' }, fixture: { 'a.js': 'x' } }), { files: [{ path: 'a.js', same: true }] }), [])
  assert.match(grade(evidence({ files: { 'a.js': 'y' }, fixture: { 'a.js': 'x' } }), { files: [{ path: 'a.js', same: true }] }).join(), /a\.js changed/)
})

test('a job check matches the cron of each job the session scheduled', () => {
  const jobs = [{ cron: '0 9 * * 1-5', prompt: 'check the build' }]
  assert.deepEqual(grade(evidence({ jobs }), { jobs: 1, jobCron: '^0 9 \\* \\* 1-5$' }), [])
  assert.match(grade(evidence({ jobs: [{ cron: '*/5 * * * *', prompt: 'x' }] }), { jobCron: '^0 9' }).join(), /job cron \*\/5 \* \* \* \* does not match/)
})

test('a run that crashed or timed out fails with its reason', () => {
  assert.match(grade(evidence({ error: 'timed out after 480s' }), {}).join(), /timed out after 480s/)
})

test('a jobs or settings count must match, a setting must match key=value, and a check that never ran fails', () => {
  assert.match(grade(evidence({ jobs: [] }), { jobs: 1 }).join(), /jobs: 0 seen, 1 expected/)
  assert.deepEqual(grade(evidence({ settings: [{ key: 'afk.model', value: 'haiku' }] }), { settings: 1, setting: '^afk\\.model=haiku$' }), [])
  assert.match(grade(evidence({ settings: [{ key: 'model', value: 'haiku' }] }), { setting: '^afk\\.model=haiku$' }).join(), /setting model=haiku does not match/)
  assert.match(grade(evidence({ commands: {} }), { commands: ['node check.js'] }).join(), /node check\.js exited never/)
})

test('a generated fixture repeats a line with its number and puts the planted lines where asked', () => {
  const text = fixtureText({ repeat: 'INFO ok id={i}', times: 4, at: { 3: 'ERROR boom' } })
  assert.equal(text, 'INFO ok id=1\nINFO ok id=2\nERROR boom\nINFO ok id=4\n')
  assert.equal(fixtureText('plain'), 'plain')
})

test('the summary gives passes, the median tokens in per turn with its spread, and the median steps', () => {
  const runs = [evidence({ turns: [{ tokensIn: 100, steps: 2 }] }), evidence({ turns: [{ tokensIn: 300, steps: 4 }] }), evidence({ turns: [{ tokensIn: 200, steps: 3 }] })]
  const s = summarize('c', runs, [[], ['miss'], []])
  assert.deepEqual(s, { name: 'c', passes: 2, runs: 3, infra: 0, tokensIn: { median: 200, min: 100, max: 300 }, steps: 3, misses: [['miss']] })
})

test('tokens in per turn average the turns of a run, and a run with no turn adds no token number', () => {
  const two = evidence({ turns: [{ tokensIn: 100, steps: 2 }, { tokensIn: 300, steps: 4 }] })
  const s = summarize('c', [two, evidence({ turns: [], error: 'timed out after 480s' })], [[], ['timed out after 480s']])
  assert.deepEqual(s.tokensIn, { median: 200, min: 200, max: 200 })
  assert.equal(s.steps, 6)
})

test('a run the API cut short (rate limit, overload) counts as neither a pass nor a fail', () => {
  const s = summarize('c', [evidence(), evidence({ infra: 'rate_limit' }), evidence()], [[], ['api'], []])
  assert.deepEqual([s.passes, s.runs, s.infra], [2, 2, 1])
})

test('the gate fails a case that fails in 2 or more of 3 runs after a change, when it failed in fewer before', () => {
  const row = (name: string, passes: number, runs = 3) => ({ name, passes, runs, infra: 3 - runs, tokensIn: { median: 1, min: 1, max: 1 }, steps: 1, misses: [] })
  assert.deepEqual(gate([row('a', 3), row('b', 1), row('c', 3)], [row('a', 2), row('b', 0), row('c', 1)]), ['c: passed 3 of 3 before, 1 of 3 after'])
  assert.deepEqual(gate([row('a', 2)], [row('a', 0)]), ['a: passed 2 of 3 before, 0 of 3 after'])
  assert.deepEqual(gate([row('a', 3)], []), ['a: missing from the after run'])
  assert.deepEqual(gate([row('a', 3)], [row('a', 2, 2)]), ['a: 1 run hit an API limit after, so run the case again'])
})
