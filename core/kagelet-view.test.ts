import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { kageletRows } from './kagelets.ts'
import { actionLine, dailyCap, kageletRuns, PANEL_KEYS, panelLines, runLine, shownState } from './kagelet-view.ts'

const LINK = 'https://test.slack.com/archives/CTEST1/p1700000000123456'
const KEY = 'CTEST1:1700000000.123456#side-kagelet-deploys'
const file = (head: string) => `---\nthread: ${LINK}\nschedule: 0 9 * * *\n${head}\n---\nPost a summary.\n`
const now = new Date(2026, 10, 14, 15, 0).getTime()
const at = (h: number, m = 0) => new Date(2026, 10, 14, h, m).toISOString()

describe('the kagelets panel in kage top', () => {
  const files = [
    { name: 'deploys', text: file('by: kage') },
    { name: 'held', text: file('paused: yes') },
    { name: 'spender', text: file('paused: yes').replace('deploys', 'spender') },
    { name: 'broken', text: 'no front matter' },
  ]
  const costs = `${at(9, 1)}\t${KEY}\t0.4\t0.4\n${at(9, 2)}\tCTEST1:1700000000.123456#side-kagelet-spender\t2.5\t2.5\n`
  const reports = `${at(9, 5)}\tdeploys\tall green\t\n`
  const rows = kageletRows(files, { runs: `${at(9)}\tkagelet-deploys\t${KEY}\n`, costs, reports, now })

  test('each kagelet reads running, paused, broken or over cap', () => {
    assert.deepEqual(rows.map(r => [r.name, shownState(r, 2)]), [['broken', 'broken'], ['deploys', 'running'], ['held', 'paused'], ['spender', 'over cap']])
  })
  test('a line shows its state, last and next run, cost against the cap and who made it; the next line its report', () => {
    const [broken, deploys, held] = panelLines(rows, now, 2)
    assert.match(deploys!.main, /^deploys +running +last 09:00 +next Sun 09:00 +\$0\.40 of \$2\.00 +by Kage$/)
    assert.equal(deploys!.report, '09:05 all green')
    assert.match(held!.main, /paused .*last never .*next - .*by owner$/)
    assert.equal(held!.report, 'no report yet')
    assert.match(broken!.main, /^broken +broken +it needs front matter/)
    assert.equal(broken!.report, '')
  })
  test('every line fits 100 columns', () => {
    for (const l of panelLines(rows, now, 2)) assert.ok(l.main.length <= 94, l.main)
  })
  test('the cap comes from the settings file, the old name too, 2 dollars when unset', () => {
    assert.equal(dailyCap({ KAGE_KAGELET_DAILY_USD: '5' }), 5)
    assert.equal(dailyCap({ KAGE_SPECIALIST_DAILY_USD: '3' }), 3)
    assert.equal(dailyCap({}), 2)
  })
})

describe('the panel keys', () => {
  test('r runs now, p pauses, u resumes, x removes; nothing saves or edits a file', () => {
    assert.deepEqual(PANEL_KEYS, { r: 'run', p: 'pause', u: 'resume', x: 'remove' })
  })
  test('the hub answer becomes one line; a hub that is down or silent is said plainly', () => {
    assert.equal(actionLine({ text: 'deploys is paused within a minute.' }, true), 'deploys is paused within a minute.')
    assert.equal(actionLine({ refused: 'no such action' }, true), 'The hub refused: no such action.')
    assert.match(actionLine(undefined, false), /^Kage is not running, so it cannot act on kagelets\. Start it with kage start\.$/)
    assert.match(actionLine(undefined, true), /does not answer.*kage restart/)
  })
})

describe('kage logs <kagelet>', () => {
  const runs = [at(9), at(10), at(14, 55)].map(t => `${t}\tkagelet-deploys\t${KEY}\n`).join('') + `${at(11)}\tkagelet-other\tC1:1.1#side-kagelet-other\n`
  const costs = `${at(9, 1)}\t${KEY}\t0.25\t0.25\n${at(9, 2)}\t${KEY}\t0.25\t0.5\n${at(10, 1)}\t${KEY}\t0.1\t0.6\n${at(10, 2)}\tC9:1.1\t9\t9\n${at(14, 56)}\t${KEY}\t0.05\t0.65\n`
  const reports = `${at(9, 3)}\tdeploys\tall green\t\n${at(10, 3)}\tother\tnot mine\t\n${at(14, 57)}\tdeploys\tread the log\tthe staging password\n`
  const list = kageletRuns('deploys', KEY, { runs, costs, reports }, now)

  test('its runs newest first, each with what it cost and its report', () => {
    assert.deepEqual(list.map(r => [new Date(r.at).getHours(), r.usd, r.status]), [[14, 0.05, 'ok'], [10, 0.1, 'failed'], [9, 0.5, 'ok']])
    assert.equal(list[2]!.report, 'all green')
    assert.equal(list[0]!.report, 'needs: the staging password (read the log)')
    assert.equal(list[1]!.report, 'no report: the run ended without one')
  })
  test('the latest run with no report yet, under an hour old, is still running', () => {
    const r = kageletRuns('deploys', KEY, { runs: `${at(14, 30)}\tkagelet-deploys\t${KEY}\n`, costs: '', reports: '' }, now)
    assert.equal(r[0]!.status, 'running')
  })
  test('a line reads time, cost, status, report', () => {
    assert.match(runLine(list[0]!, now), /^14:55 +\$0\.05 +ok +needs: the staging password/)
  })
  test('runs from before the rename (spec-) count too', () => {
    assert.equal(kageletRuns('deploys', KEY, { runs: `${at(9)}\tspec-deploys\t${KEY}\n`, costs: '', reports: '' }, now).length, 1)
  })
})
