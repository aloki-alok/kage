import { test } from 'node:test'
import assert from 'node:assert/strict'
import { issueBody, issueLink, reportFingerprint, repoFromRemote, reportsToday, scrubReport, type IssueReport } from '../issue-report.ts'
import { wordingProblems } from '../skill-lessons.ts'

test("the repo is the checkout's origin, a fork files to the fork, and the setting overrides both", () => {
  assert.equal(repoFromRemote('https://github.com/aloki-alok/kage.git'), 'aloki-alok/kage')
  assert.equal(repoFromRemote('git@github.com:some-fork/kage.git'), 'some-fork/kage')
  assert.equal(repoFromRemote('ssh://git@github.com/some-fork/kage'), 'some-fork/kage')
  assert.equal(repoFromRemote('https://gitlab.com/a/kage.git'), undefined)
  assert.equal(repoFromRemote('git@github.com:some-fork/kage.git', 'other/kage'), 'other/kage')
  assert.equal(repoFromRemote('', 'not a repo'), undefined)
})

const leaky: IssueReport = {
  kind: 'bug',
  title: 'Reply failed for Priya in U0TEST1234',
  what: 'Sending to ops-team@example.com from /Users/priya/kage failed with xoxb-123-456-abcdef and host 10.1.2.3, see db.prod.internal.example.com',
  expected: 'The owner said "please just send it" and it should send',
  steps: 'Ask in C0TEST5678',
}

test('the scrub leaves no name, member id, email, path, token, address, host or quote', () => {
  const r = scrubReport(leaky, ['Priya'])
  const all = [r.title, r.what, r.expected, r.steps ?? ''].join('\n')
  assert.deepEqual(wordingProblems(all, ['Priya']).filter(p => p !== 'a date'), [])
  for (const leak of ['priya', 'ops-team@example.com', 'U0TEST1234', 'C0TEST5678', 'xoxb-', '10.1.2.3', 'prod.internal', 'please just send it']) assert.equal(all.toLowerCase().includes(leak.toLowerCase()), false, leak)
  assert.match(r.what, /~\/kage/)
})

test('the scrub keeps the words that describe the bug', () => {
  const r = scrubReport({ kind: 'bug', title: 'kage top crashes on a 40-column terminal', what: 'It throws in src/core/top-layout.ts on 0.4.6', expected: 'It draws a narrow layout' }, [])
  assert.equal(r.title, 'kage top crashes on a 40-column terminal')
  assert.equal(r.what, 'It throws in src/core/top-layout.ts on 0.4.6')
})

test('a bug fills the Report from Kage form, and an idea fills the Idea form', () => {
  const sys = { version: '0.4.6 abc1234', system: 'darwin arm64' }
  const bug = issueBody({ kind: 'bug', title: 't', what: 'w', expected: 'e', steps: 's' }, sys, 'abc123def456')
  assert.deepEqual(bug.labels, ['bug', 'from-agent'])
  assert.match(bug.body, /### Fingerprint\n\nabc123def456\n\n### What happened\n\nw\n\n### What should have happened\n\ne\n\n### Steps to see it again\n\ns\n\n### Version and system\n\n0\.4\.6 abc1234 darwin arm64/)
  assert.deepEqual(issueBody({ kind: 'feedback', title: 't', what: 'w', expected: 'e' }, sys, 'f').labels, ['bug', 'from-agent'])
  const idea = issueBody({ kind: 'idea', title: 't', what: 'w', expected: 'e' }, sys, 'abc123def456')
  assert.deepEqual(idea.labels, ['idea', 'from-agent'])
  assert.equal(idea.body, '### The job\n\nw\n\n### How you would know it works\n\ne\n\n### Fingerprint\n\nabc123def456')
})

test('the prefilled link opens the matching form with each field filled', () => {
  const sys = { version: '0.4.6', system: 'linux x64' }
  const bug = new URL(issueLink('a/kage', { kind: 'bug', title: 'Tab & space', what: 'w', expected: 'e' }, sys, 'abc123def456'))
  assert.equal(bug.origin + bug.pathname, 'https://github.com/a/kage/issues/new')
  assert.deepEqual(Object.fromEntries(bug.searchParams), { template: 'agent-report.yml', title: 'Tab & space', fingerprint: 'abc123def456', what: 'w', expected: 'e', version: '0.4.6 linux x64' })
  const idea = new URL(issueLink('a/kage', { kind: 'idea', title: 't', what: 'w', expected: 'e' }, sys, 'abc123def456'))
  assert.deepEqual(Object.fromEntries(idea.searchParams), { template: 'feature.yml', title: 't', job: 'w', done: 'e' })
})

test("today's filings count toward the daily cap, and a denied or capped one does not", () => {
  const rows = [
    ['2026-11-23T23:00:00.000Z', 'C1:1.1', 'bug', 'filed', 'u'],
    ['2026-11-24T01:00:00.000Z', 'C1:1.1', 'bug', 'filed', 'u'],
    ['2026-11-24T02:00:00.000Z', 'C1:1.1', 'idea', 'link', 'u'],
    ['2026-11-24T03:00:00.000Z', 'C1:1.1', 'bug', 'denied', ''],
    ['2026-11-24T04:00:00.000Z', 'C1:1.1', 'bug', 'capped', ''],
    ['2026-11-24T05:00:00.000Z', 'C1:1.1', 'bug', 'commented', 'u'],
  ].map(r => r.join('\t')).join('\n')
  assert.equal(reportsToday(rows, '2026-11-24'), 3)
})

test('the fingerprint is a crash fingerprint when the session has one, else the kind and the title, so a reworded case or stop still matches', () => {
  const bug = (title: string, kind: IssueReport['kind'] = 'bug') => ({ kind, title, what: 'w', expected: 'e' })
  const fp = reportFingerprint(bug('Reply failed in a thread'))
  assert.match(fp, /^[0-9a-f]{12}$/)
  assert.equal(reportFingerprint({ ...bug('  reply FAILED, in a thread. '), what: 'other words' }), fp)
  assert.notEqual(reportFingerprint(bug('Reply failed in a channel')), fp)
  assert.notEqual(reportFingerprint(bug('Reply failed in a thread', 'idea')), fp)
  assert.equal(reportFingerprint(bug('anything'), '0123456789ab'), '0123456789ab')
  assert.equal(reportFingerprint(bug('Reply failed in a thread'), 'not a fingerprint'), fp)
})

test('the scrub also takes app tokens, bearer tokens, channel names, links, phone numbers, single quotes, Windows paths and names with accents', () => {
  const text = [
    'token xapp-1-A0TEST-123-abcdef and Bearer abcdefghijklmnopqrstuvwxyzABCDEF',
    'posted in #customer-acme and <#C0TEST1234|customer-acme>',
    'opened https://acme.com/reset?token=abc123',
    'called +1 415 555 0134',
    "she said 'ship it tonight' then",
    'C:\\Users\\zoe\\kage failed for Zoë',
  ].join('\n')
  const out = scrubReport({ kind: 'bug', title: 't', what: text, expected: 'e' }, ['Zoë']).what
  for (const leak of ['xapp-', 'abcdefghijklmnop', 'customer-acme', 'acme.com', 'token=abc', '555 0134', 'ship it tonight', 'zoe', 'Zoë']) assert.equal(out.includes(leak), false, `${leak} in ${out}`)
})

test('the scrub leaves capital words and plain apostrophes alone', () => {
  const r = scrubReport({ kind: 'bug', title: 'ATTACHMENTS do not upload', what: "the users' guide and the owners' list", expected: 'e' }, [])
  assert.deepEqual([r.title, r.what], ['ATTACHMENTS do not upload', "the users' guide and the owners' list"])
})

test('a remote with credentials in it still names its repo', () => {
  assert.equal(repoFromRemote('https://x-access-token:abc@github.com/some-fork/kage.git'), 'some-fork/kage')
})

test('the scrub keeps what a bug report needs: issue refs, dates, versions, file names, identifiers and long numbers', () => {
  const kept = 'issue #541 and PR #12 on 2026-11-24 at 10:30:45, kage 0.4.6 on node 22.11.0, src/core/dream.test.ts:123 and setup.sh, call fooBar.baz.qux() at 1732400000000, pid 123456789, hash abcdef1234567890'
  assert.equal(scrubReport({ kind: 'bug', title: 't', what: kept, expected: 'e' }, []).what, kept)
})

test('a host with two labels, and phone numbers in their usual shapes, are scrubbed', () => {
  const out = scrubReport({ kind: 'bug', title: 't', what: 'sent from example.com and www.acme.io/path, call (415) 555-0134 or +44 20 7946 0958', expected: 'e' }, []).what
  for (const leak of ['example.com', 'acme.io', '555-0134', '7946']) assert.equal(out.includes(leak), false, `${leak} in ${out}`)
})
