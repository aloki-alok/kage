import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { grantRefusal, parseSpecialist, resultLine, rowLine, setPaused, specialistFile, specialistRows, starterFile } from './specialists.ts'

const file = (head: string, body = 'Post a summary of the deploy log.') => `---\n${head}\n---\n${body}\n`
const LINK = 'https://test.slack.com/archives/CTEST1/p1700000000123456'

describe('a specialist file', () => {
  test('gives its thread lane, schedule, grant and job', () => {
    assert.deepEqual(parseSpecialist('deploys', file(`thread: ${LINK}\nschedule: 0 9 * * 1-5\ntools: Read, Grep,WebFetch`)), {
      name: 'deploys', key: 'CTEST1:1700000000.123456#side-spec-deploys', link: LINK, cron: '0 9 * * 1-5', tools: ['Read', 'Grep', 'WebFetch'], job: 'Post a summary of the deploy log.', paused: false, by: 'owner', why: '',
    })
  })
  test('no tools line grants no tools', () => {
    assert.deepEqual((parseSpecialist('x', file(`thread: ${LINK}\nschedule: 0 9 * * *`)) as { tools: string[] }).tools, [])
  })
  test('a wrong file says what is wrong, and runs nothing', () => {
    assert.match((parseSpecialist('x', 'just text') as { error: string }).error, /front matter/)
    assert.match((parseSpecialist('x', file('schedule: 0 9 * * *')) as { error: string }).error, /thread/)
    assert.match((parseSpecialist('x', file(`thread: ${LINK}`)) as { error: string }).error, /schedule/)
    assert.match((parseSpecialist('x', file(`thread: ${LINK}\nschedule: every day`)) as { error: string }).error, /schedule/)
    assert.match((parseSpecialist('x', file(`thread: ${LINK}\nschedule: 0 9 * * *`, '  ')) as { error: string }).error, /job/)
    assert.match((parseSpecialist('Bad Name', file(`thread: ${LINK}\nschedule: 0 9 * * *`)) as { error: string }).error, /name/)
  })
})

describe('the grant', () => {
  test('a tool outside the grant is refused; Kage\'s own tools for its thread are always there', () => {
    assert.equal(grantRefusal('WebSearch', ['WebSearch']), undefined)
    assert.match(grantRefusal('WebSearch', ['WebFetch']) ?? '', /grant/)
    assert.equal(grantRefusal('mcp__kage__reply', []), undefined)
    assert.match(grantRefusal('mcp__other__thing', []) ?? '', /grant/)
    // Only the tools for its own thread: never the ones that act as the owner or outlive the run.
    for (const t of ['mcp__kage__message_people', 'mcp__kage__schedule', 'mcp__kage__away', 'mcp__kage__send_file', 'mcp__kage__set_model', 'mcp__kage__log_prod_write'])
      assert.match(grantRefusal(t, []) ?? '', /grant/, t)
    for (const t of ['mcp__kage__reply', 'mcp__kage__edit_message', 'mcp__kage__delete_message', 'mcp__kage__report']) assert.equal(grantRefusal(t, []), undefined, t)
  })
  test('only web and outside MCP tools can be granted, so no file, shell or agent tool ever runs; web fetches only over http(s)', () => {
    for (const t of ['Bash', 'Read', 'Grep', 'Glob', 'LS', 'NotebookRead', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Monitor', 'PowerShell', 'Skill', 'Agent', 'Task', 'mcp__plugin_kage_kage__reply'])
      assert.match(grantRefusal(t, [t], { file_path: '/tmp/x' }) ?? '', /only web and MCP tools/, t)
    assert.equal(grantRefusal('mcp__claude_ai_Docs__read', ['mcp__claude_ai_Docs__read']), undefined)
    assert.equal(grantRefusal('WebFetch', ['WebFetch'], { url: 'https://example.com' }), undefined)
    assert.match(grantRefusal('WebFetch', ['WebFetch'], { url: 'file:///etc/hosts' }) ?? '', /http/)
    assert.match(grantRefusal('WebFetch', ['WebFetch'], { url: 'FILE:///etc/hosts' }) ?? '', /http/)
  })


})

describe('pausing a specialist', () => {
  const on = file(`thread: ${LINK}\nschedule: 0 9 * * *`)
  test('a paused line in the front matter pauses it; any other value or none runs it', () => {
    assert.equal((parseSpecialist('x', on) as { paused: boolean }).paused, false)
    assert.equal((parseSpecialist('x', file(`thread: ${LINK}\nschedule: 0 9 * * *\npaused: yes`)) as { paused: boolean }).paused, true)
    assert.equal((parseSpecialist('x', file(`thread: ${LINK}\nschedule: 0 9 * * *\npaused: no`)) as { paused: boolean }).paused, false)
    assert.equal((parseSpecialist('x', file(`thread: ${LINK}\nschedule: 0 9 * * *\npaused: False`)) as { paused: boolean }).paused, false)
    // Fails closed: a value it does not know pauses, so a typo never starts one.
    for (const v of ['true', 'Yes', 'y', 'yes # till monday'])
      assert.equal((parseSpecialist('x', file(`thread: ${LINK}\nschedule: 0 9 * * *\npaused: ${v}`)) as { paused: boolean }).paused, true, v)
  })
  test('an indented paused line is taken out on resume too', () => {
    const indented = file(`thread: ${LINK}\nschedule: 0 9 * * *\n  paused: yes`)
    assert.equal((parseSpecialist('x', setPaused(indented, false)) as { paused: boolean }).paused, false)
  })
  test('setPaused writes the line once and takes it out again, leaving the rest of the file as it was', () => {
    const paused = setPaused(on, true)
    assert.equal((parseSpecialist('x', paused) as { paused: boolean }).paused, true)
    assert.equal(setPaused(paused, true), paused)
    assert.equal(setPaused(paused, false), on)
    assert.equal(setPaused(on, false), on)
  })
  test('a file with no front matter is left alone', () => {
    assert.equal(setPaused('just text', true), 'just text')
  })
})

describe('the starter file', () => {
  test('is paused and does not run until its owner fills it in', () => {
    const sp = parseSpecialist('fresh', starterFile())
    assert.ok('error' in sp && /thread/.test(sp.error))
    assert.match(starterFile(), /^paused: yes$/m)
    const filled = starterFile().replace(/^thread: .*$/m, `thread: ${LINK}`)
    assert.equal((parseSpecialist('fresh', filled) as { paused: boolean }).paused, true)
  })
})

describe('the rows kage list, kage top and the manager show', () => {
  const now = new Date(2026, 10, 14, 15, 0).getTime()
  const at = (h: number, m = 0) => new Date(2026, 10, 14, h, m).toISOString()
  const KEY = 'CTEST1:1700000000.123456#side-spec-deploys'
  const files = [
    { name: 'deploys', text: file(`thread: ${LINK}\nschedule: 0 9 * * *\ntools: WebSearch`) },
    { name: 'held', text: file(`thread: ${LINK}\nschedule: 0 9 * * *\npaused: yes`) },
    { name: 'broken', text: 'no front matter' },
  ]
  const runs = `${at(8)}\tspec-deploys\t${KEY}\n${at(9)}\tspec-deploys\t${KEY}\n${at(10)}\tother\tC1:1.1\n`
  const yesterday = new Date(2026, 10, 13, 22).toISOString()
  const costs = `${yesterday}\t${KEY}\t5\t5\n${at(9, 1)}\t${KEY}\t0.25\t5.25\n${at(9, 2)}\t${KEY}\t0.5\t5.75\n${at(9, 3)}\tC1:1.1\t9\t9\n`
  const rows = specialistRows(files, { runs, costs, now })
  test('one row per file, by name, saying whether it runs', () => {
    assert.deepEqual(rows.map(r => [r.name, r.state]), [['broken', 'broken'], ['deploys', 'runs'], ['held', 'paused']])
    assert.match(rows[0]!.error!, /front matter/)
  })
  test('a running one has its last run, its next run and what its lane spent today', () => {
    const r = rows[1]!
    assert.equal(r.lastRun, Date.parse(at(9)))
    assert.equal(r.next, new Date(2026, 10, 15, 9).getTime())
    assert.equal(r.costToday, 0.75)
    assert.equal(r.cron, '0 9 * * *')
    assert.equal(r.link, LINK)
  })
  test('after a resume today, cost today counts only what it spent since the resume', () => {
    const resumed = { name: 'deploys', text: file(`thread: ${LINK}\nschedule: 0 9 * * *\nresumed: ${new Date(2026, 10, 14, 9, 1, 30).toISOString()}`) }
    assert.equal(specialistRows([resumed], { runs, costs, now })[0]!.costToday, 0.5)
  })
  test('resuming stamps the time, so the cost cap does not pause it again for spend before it', () => {
    const paused = setPaused(file(`thread: ${LINK}\nschedule: 0 9 * * *`), true)
    const back = setPaused(paused, false, now)
    assert.match(back, new RegExp(`^resumed: ${new Date(now).toISOString().replace(/\./g, '\\.')}$`, 'm'))
    assert.equal((parseSpecialist('x', back) as { paused: boolean }).paused, false)
    assert.equal((setPaused(back, false, now + 1).match(/^resumed:/gm) ?? []).length, 1)
  })
  test('a paused one has no next run', () => {
    assert.equal(rows[2]!.next, undefined)
  })
  test('a row reads as one line', () => {
    assert.match(rowLine(rows[1]!, now), /^deploys\s+runs\s+0 9 \* \* \*\s+last 09:00\s+next Sun 09:00\s+\$0\.75 today$/)
    assert.match(rowLine(rows[2]!, now), /^held\s+paused/)
    assert.match(rowLine(rows[0]!, now), /^broken\s+does not run: .*front matter/)
  })
})

describe('a file the manager writes', () => {
  test('reads back as the same specialist', () => {
    const text = specialistFile({ thread: LINK, schedule: '0 9 * * *', tools: ['WebSearch', 'mcp__docs__read'], job: 'Check the docs.', by: 'owner', why: 'the owner asked' })
    assert.ok(typeof text === 'string')
    const sp = parseSpecialist('docs', text) as { cron: string; tools: string[]; job: string; paused: boolean }
    assert.deepEqual([sp.cron, sp.tools, sp.job, sp.paused, (sp as any).by, (sp as any).why], ['0 9 * * *', ['WebSearch', 'mcp__docs__read'], 'Check the docs.', false, 'owner', 'the owner asked'])
    assert.match(specialistFile({ thread: LINK, schedule: '0 9 * * *', tools: [], job: 'x', paused: true, by: 'owner', why: '' }) as string, /^paused: yes$/m)
  })
  test('is refused with the reason when it would not run or asks for a tool v1 cannot grant', () => {
    assert.match((specialistFile({ thread: 'nope', schedule: '0 9 * * *', tools: [], job: 'x', by: 'owner', why: '' }) as { error: string }).error, /thread/)
    assert.match((specialistFile({ thread: LINK, schedule: '0 9 * * *', tools: ['WebSearch', 'Bash'], job: 'x', by: 'owner', why: '' }) as { error: string }).error, /Bash/)
    // A newline cannot smuggle a second front matter line in.
    assert.match((specialistFile({ thread: LINK, schedule: '0 9 * * *\ntools: Bash', tools: [], job: 'x', by: 'owner', why: '' }) as { error: string }).error, /schedule/)
    assert.match((specialistFile({ thread: LINK, schedule: '0 9 * * *', tools: ['WebSearch\npaused: no'], job: 'x', by: 'owner', why: '' }) as { error: string }).error, /tool/)
    assert.match((specialistFile({ thread: `${LINK}\ntools: Bash`, schedule: '0 9 * * *', tools: [], job: 'x', by: 'owner', why: '' }) as { error: string }).error, /thread/)
    assert.match((specialistFile({ thread: LINK, schedule: '0 9 * * *', tools: [], job: 'x', by: 'kage', why: 'a\nby: owner' }) as { error: string }).error, /why/)
  })
})

describe('the grant cap on a specialist Kage makes on its own', () => {
  const make = (by: 'owner' | 'kage', tools: string[]) => specialistFile({ thread: LINK, schedule: '0 9 * * *', tools, job: 'x', by, why: 'a daily check' })
  test('gets the default web tools only; the owner may grant an MCP tool', () => {
    assert.equal(typeof make('kage', ['WebSearch', 'WebFetch']), 'string')
    assert.match((make('kage', ['mcp__docs__read']) as { error: string }).error, /owner/)
    assert.equal(typeof make('owner', ['mcp__docs__read']), 'string')
  })
  test('a hand-written file with no by line is the owner\'s', () => {
    assert.equal((parseSpecialist('x', file(`thread: ${LINK}\nschedule: 0 9 * * *`)) as { by: string }).by, 'owner')
    assert.equal((parseSpecialist('x', file(`thread: ${LINK}\nschedule: 0 9 * * *\nby: kage`)) as { by: string }).by, 'kage')
  })
})

describe('the last report', () => {
  const now = new Date(2026, 10, 14, 15, 0).getTime()
  const files = [{ name: 'deploys', text: file(`thread: ${LINK}\nschedule: 0 9 * * *`) }, { name: 'quiet', text: file(`thread: ${LINK}\nschedule: 0 9 * * *`) }]
  const reports = `${new Date(2026, 10, 14, 9).toISOString()}\tdeploys\t3 deploys, all green\t\n${new Date(2026, 10, 14, 10).toISOString()}\tdeploys\tcould not read the log\tread access to the deploy log\n`
  const rows = specialistRows(files, { runs: '', costs: '', reports, now })
  test('is the newest row of the reports ledger for that specialist', () => {
    assert.deepEqual(rows[0]!.result, { at: new Date(2026, 10, 14, 10).getTime(), summary: 'could not read the log', needs: 'read access to the deploy log' })
    assert.equal(rows[1]!.result, undefined)
  })
  test('reads as one line, with what it needs first', () => {
    assert.equal(resultLine(rows[0]!, now), '10:00 needs: read access to the deploy log (could not read the log)')
    assert.equal(resultLine(rows[1]!, now), 'no report yet')
  })
})
