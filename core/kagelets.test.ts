import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { budgetLeft, capCheck, chainErrors, costFlags, grantRefusal, parseKagelet, resultLine, revokeStanding, rowLine, setPaused, kageletFile, kageletRows, standingApplies, starterFile, type Kagelet, type KageletRow, type Standing } from './kagelets.ts'

const file = (head: string, body = 'Post a summary of the deploy log.') => `---\n${head}\n---\n${body}\n`
const LINK = 'https://test.slack.com/archives/CTEST1/p1700000000123456'

describe('a kagelet file', () => {
  test('gives its thread lane, schedule, grant and job', () => {
    assert.deepEqual(parseKagelet('deploys', file(`thread: ${LINK}\nschedule: 0 9 * * 1-5\ntools: Read, Grep,WebFetch`)), {
      name: 'deploys', key: 'CTEST1:1700000000.123456#side-kagelet-deploys', link: LINK, cron: '0 9 * * 1-5', tools: ['Read', 'Grep', 'WebFetch'], job: 'Post a summary of the deploy log.', paused: false, by: 'owner', why: '',
    })
  })
  test('no tools line grants no tools', () => {
    assert.deepEqual((parseKagelet('x', file(`thread: ${LINK}\nschedule: 0 9 * * *`)) as { tools: string[] }).tools, [])
  })
  test('a wrong file says what is wrong, and runs nothing', () => {
    assert.match((parseKagelet('x', 'just text') as { error: string }).error, /front matter/)
    assert.match((parseKagelet('x', file('schedule: 0 9 * * *')) as { error: string }).error, /thread/)
    assert.match((parseKagelet('x', file(`thread: ${LINK}`)) as { error: string }).error, /schedule/)
    assert.match((parseKagelet('x', file(`thread: ${LINK}\nschedule: every day`)) as { error: string }).error, /schedule/)
    assert.match((parseKagelet('x', file(`thread: ${LINK}\nschedule: 0 9 * * *`, '  ')) as { error: string }).error, /job/)
    assert.match((parseKagelet('Bad Name', file(`thread: ${LINK}\nschedule: 0 9 * * *`)) as { error: string }).error, /name/)
  })
})

describe('the db_read grant', () => {
  test('db_read runs only where the grant names it', () => {
    assert.equal(grantRefusal('mcp__kage__db_read', ['db_read']), undefined)
    assert.match(grantRefusal('mcp__kage__db_read', ['WebSearch']) ?? '', /grant/)
    assert.match(grantRefusal('mcp__kage__db_read', []) ?? '', /grant/)
  })
  test('the tool writes it only with the owner\'s approval, which the file records; by hand, the owner needs none', () => {
    const f = { thread: LINK, schedule: '0 9 * * *', job: 'Count failed calls.', why: 'watch' }
    for (const by of ['owner', 'kage'] as const) assert.match((kageletFile({ ...f, tools: ['db_read'], by }) as { error: string }).error, /db_read/)
    const text = kageletFile({ ...f, tools: ['WebSearch', 'db_read'], by: 'kage', granted: Date.UTC(2026, 0, 2) }) as string
    assert.match(text, /^granted: db_read by the owner, 2026-01-02T00:00:00\.000Z$/m)
    const k = parseKagelet('x', text) as { tools: string[]; granted?: number }
    assert.deepEqual([k.tools, k.granted], [['WebSearch', 'db_read'], Date.UTC(2026, 0, 2)])
    // Without db_read, no grant line.
    assert.doesNotMatch(kageletFile({ ...f, tools: ['WebSearch'], by: 'kage', granted: 1 }) as string, /granted/)
    assert.match((parseKagelet('x', file(`thread: ${LINK}\nschedule: 0 9 * * *\ntools: db_read\nby: kage`)) as { error: string }).error, /db_read/)
    assert.match((parseKagelet('x', file(`thread: ${LINK}\nschedule: 0 9 * * *\ntools: db_read\nby: kage\ngranted: db_read by the owner, not a time`)) as { error: string }).error, /db_read/)
    assert.deepEqual((parseKagelet('x', file(`thread: ${LINK}\nschedule: 0 9 * * *\ntools: db_read`)) as { tools: string[] }).tools, ['db_read'])
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
    for (const t of ['mcp__kage__reply', 'mcp__kage__edit_message', 'mcp__kage__delete_message', 'mcp__kage__report', 'mcp__kage__message_kagelet']) assert.equal(grantRefusal(t, []), undefined, t)
  })
  test('ToolSearch is always there, since a granted tool may load deferred; what it loads still passes the grant', () => {
    assert.equal(grantRefusal('ToolSearch', ['WebFetch'], { query: 'select:WebFetch' }), undefined)
    assert.equal(grantRefusal('WebFetch', ['WebFetch'], { url: 'https://example.com' }), undefined)
    assert.match(grantRefusal('Bash', ['WebFetch']) ?? '', /only web and MCP tools/)
    assert.match(grantRefusal('Agent', ['WebFetch']) ?? '', /only web and MCP tools/)
    assert.match(grantRefusal('WebSearch', ['WebFetch']) ?? '', /grant/)
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

describe('pausing a kagelet', () => {
  const on = file(`thread: ${LINK}\nschedule: 0 9 * * *`)
  test('a paused line in the front matter pauses it; any other value or none runs it', () => {
    assert.equal((parseKagelet('x', on) as { paused: boolean }).paused, false)
    assert.equal((parseKagelet('x', file(`thread: ${LINK}\nschedule: 0 9 * * *\npaused: yes`)) as { paused: boolean }).paused, true)
    assert.equal((parseKagelet('x', file(`thread: ${LINK}\nschedule: 0 9 * * *\npaused: no`)) as { paused: boolean }).paused, false)
    assert.equal((parseKagelet('x', file(`thread: ${LINK}\nschedule: 0 9 * * *\npaused: False`)) as { paused: boolean }).paused, false)
    // Fails closed: a value it does not know pauses, so a typo never starts one.
    for (const v of ['true', 'Yes', 'y', 'yes # till monday'])
      assert.equal((parseKagelet('x', file(`thread: ${LINK}\nschedule: 0 9 * * *\npaused: ${v}`)) as { paused: boolean }).paused, true, v)
  })
  test('an indented paused line is taken out on resume too', () => {
    const indented = file(`thread: ${LINK}\nschedule: 0 9 * * *\n  paused: yes`)
    assert.equal((parseKagelet('x', setPaused(indented, false)) as { paused: boolean }).paused, false)
  })
  test('setPaused writes the line once and takes it out again, leaving the rest of the file as it was', () => {
    const paused = setPaused(on, true)
    assert.equal((parseKagelet('x', paused) as { paused: boolean }).paused, true)
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
    const sp = parseKagelet('fresh', starterFile())
    assert.ok('error' in sp && /thread/.test(sp.error))
    assert.match(starterFile(), /^paused: yes$/m)
    const filled = starterFile().replace(/^thread: .*$/m, `thread: ${LINK}`)
    assert.equal((parseKagelet('fresh', filled) as { paused: boolean }).paused, true)
  })
})

describe('the rows kage list, kage top and the manager show', () => {
  const now = new Date(2026, 10, 14, 15, 0).getTime()
  const at = (h: number, m = 0) => new Date(2026, 10, 14, h, m).toISOString()
  const KEY = 'CTEST1:1700000000.123456#side-kagelet-deploys'
  const files = [
    { name: 'deploys', text: file(`thread: ${LINK}\nschedule: 0 9 * * *\ntools: WebSearch`) },
    { name: 'held', text: file(`thread: ${LINK}\nschedule: 0 9 * * *\npaused: yes`) },
    { name: 'broken', text: 'no front matter' },
  ]
  const runs = `${at(8)}\tkagelet-deploys\t${KEY}\n${at(9)}\tkagelet-deploys\t${KEY}\n${at(10)}\tother\tC1:1.1\n`
  const yesterday = new Date(2026, 10, 13, 22).toISOString()
  const costs = `${yesterday}\t${KEY}\t5\t5\n${at(9, 1)}\t${KEY}\t0.25\t5.25\n${at(9, 2)}\t${KEY}\t0.5\t5.75\n${at(9, 3)}\tC1:1.1\t9\t9\n`
  const rows = kageletRows(files, { runs, costs, now })
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
    assert.equal(kageletRows([resumed], { runs, costs, now })[0]!.costToday, 0.5)
  })
  test('resuming stamps the time, so the cost cap does not pause it again for spend before it', () => {
    const paused = setPaused(file(`thread: ${LINK}\nschedule: 0 9 * * *`), true)
    const back = setPaused(paused, false, now)
    assert.match(back, new RegExp(`^resumed: ${new Date(now).toISOString().replace(/\./g, '\\.')}$`, 'm'))
    assert.equal((parseKagelet('x', back) as { paused: boolean }).paused, false)
    assert.equal(setPaused(back, false, now + 1), back)   // resuming one that runs changes nothing
  })
  test('a paused one has no next run', () => {
    assert.equal(rows[2]!.next, undefined)
  })
  test('a row reads as one line', () => {
    assert.match(rowLine(rows[1]!, now), /^deploys\s+runs\s+0 9 \* \* \*\s+last 09:00\s+next Sun 09:00\s+\$0\.75 today, avg \$0\.71$/)
    assert.match(rowLine(rows[2]!, now), /^held\s+paused/)
    assert.match(rowLine(rows[0]!, now), /^broken\s+does not run: .*front matter/)
  })
})

describe('a file the manager writes', () => {
  test('reads back as the same kagelet', () => {
    const text = kageletFile({ thread: LINK, schedule: '0 9 * * *', tools: ['WebSearch', 'mcp__docs__read'], job: 'Check the docs.', by: 'owner', why: 'the owner asked', approved: true })
    assert.ok(typeof text === 'string')
    const sp = parseKagelet('docs', text) as { cron: string; tools: string[]; job: string; paused: boolean }
    assert.deepEqual([sp.cron, sp.tools, sp.job, sp.paused, (sp as any).by, (sp as any).why], ['0 9 * * *', ['WebSearch', 'mcp__docs__read'], 'Check the docs.', false, 'owner', 'the owner asked'])
    assert.match(kageletFile({ thread: LINK, schedule: '0 9 * * *', tools: [], job: 'x', paused: true, by: 'owner', why: '' }) as string, /^paused: yes$/m)
  })
  test('is refused with the reason when it would not run or asks for a tool v1 cannot grant', () => {
    assert.match((kageletFile({ thread: 'nope', schedule: '0 9 * * *', tools: [], job: 'x', by: 'owner', why: '' }) as { error: string }).error, /thread/)
    assert.match((kageletFile({ thread: LINK, schedule: '0 9 * * *', tools: ['WebSearch', 'Bash'], job: 'x', by: 'owner', why: '' }) as { error: string }).error, /Bash/)
    // A newline cannot smuggle a second front matter line in.
    assert.match((kageletFile({ thread: LINK, schedule: '0 9 * * *\ntools: Bash', tools: [], job: 'x', by: 'owner', why: '' }) as { error: string }).error, /schedule/)
    assert.match((kageletFile({ thread: LINK, schedule: '0 9 * * *', tools: ['WebSearch\npaused: no'], job: 'x', by: 'owner', why: '' }) as { error: string }).error, /tool/)
    assert.match((kageletFile({ thread: `${LINK}\ntools: Bash`, schedule: '0 9 * * *', tools: [], job: 'x', by: 'owner', why: '' }) as { error: string }).error, /thread/)
    assert.match((kageletFile({ thread: LINK, schedule: '0 9 * * *', tools: [], job: 'x', by: 'kage', why: 'a\nby: owner' }) as { error: string }).error, /why/)
  })
})

describe('a tool beyond the default web tools', () => {
  const make = (by: 'owner' | 'kage', tools: string[], approved?: true) => kageletFile({ thread: LINK, schedule: '0 9 * * *', tools, job: 'x', by, why: 'a daily check', ...approved && { approved } })
  test('needs the owner\'s yes on a card, whoever the file says made it', () => {
    assert.equal(typeof make('kage', ['WebSearch', 'WebFetch']), 'string')
    for (const by of ['owner', 'kage'] as const) assert.match((make(by, ['mcp__gmail__send']) as { error: string }).error, /owner/)
    assert.equal(typeof make('kage', ['mcp__gmail__send'], true), 'string')
    // A comma or space in one name would read back as two tools, one the card never named.
    for (const t of ['mcp__a__b,db_read', 'mcp__a__b db_read']) assert.match((make('owner', [t], true) as { error: string }).error, /tool name/)
  })
  test('a hand-written file with no by line is the owner\'s', () => {
    assert.equal((parseKagelet('x', file(`thread: ${LINK}\nschedule: 0 9 * * *`)) as { by: string }).by, 'owner')
    assert.equal((parseKagelet('x', file(`thread: ${LINK}\nschedule: 0 9 * * *\nby: kage`)) as { by: string }).by, 'kage')
  })
})

describe('the last report', () => {
  const now = new Date(2026, 10, 14, 15, 0).getTime()
  const files = [{ name: 'deploys', text: file(`thread: ${LINK}\nschedule: 0 9 * * *`) }, { name: 'quiet', text: file(`thread: ${LINK}\nschedule: 0 9 * * *`) }]
  const reports = `${new Date(2026, 10, 14, 9).toISOString()}\tdeploys\t3 deploys, all green\t\n${new Date(2026, 10, 14, 10).toISOString()}\tdeploys\tcould not read the log\tread access to the deploy log\n`
  const rows = kageletRows(files, { runs: '', costs: '', reports, now })
  test('is the newest row of the reports ledger for that kagelet', () => {
    assert.deepEqual(rows[0]!.result, { at: new Date(2026, 10, 14, 10).getTime(), summary: 'could not read the log', needs: 'read access to the deploy log' })
    assert.equal(rows[1]!.result, undefined)
  })
  test('reads as one line, with what it needs first', () => {
    assert.equal(resultLine(rows[0]!, now), '10:00 needs: read access to the deploy log (could not read the log)')
    assert.equal(resultLine(rows[1]!, now), 'no report yet')
  })
})

describe('a run ledger row from before the rename', () => {
  test('still counts as that kagelet\'s last run', () => {
    const now = new Date(2026, 10, 14, 15, 0).getTime()
    const rows = kageletRows([{ name: 'deploys', text: file(`thread: ${LINK}\nschedule: 0 9 * * *`) }], { runs: `${new Date(2026, 10, 14, 9).toISOString()}\tspec-deploys\tC:1.1#side-spec-deploys\n`, costs: '', now })
    assert.equal(rows[0]!.lastRun, new Date(2026, 10, 14, 9).getTime())
  })
})

describe('a standing approval (#96)', () => {
  const f = { thread: LINK, schedule: '0 9 * * *', job: 'Count failed calls.', why: 'watch', by: 'kage' as const }
  const yes: Standing = { tool: 'db_read', command: 'hash-a', at: 1 }
  test('covers the same tool through the same read command, from the owner\'s session only', () => {
    assert.equal(standingApplies(yes, { tool: 'db_read', command: 'hash-a', owner: true }), true)
    assert.equal(standingApplies(undefined, { tool: 'db_read', command: 'hash-a', owner: true }), false)
    // A different read command, a teammate's session, or another tool still needs the owner.
    assert.equal(standingApplies(yes, { tool: 'db_read', command: 'hash-b', owner: true }), false)
    assert.equal(standingApplies(yes, { tool: 'db_read', command: 'hash-a', owner: false }), false)
    assert.equal(standingApplies(yes, { tool: 'mcp__mail__send', command: 'hash-a', owner: true }), false)
    assert.equal(standingApplies({ ...yes, tool: 'mcp__mail__send' }, { tool: 'mcp__mail__send', command: 'hash-a', owner: true }), false)
  })
  test('a grant it gave reads back as standing; the owner\'s card yes does not', () => {
    const auto = kageletFile({ ...f, tools: ['WebSearch', 'db_read'], granted: Date.UTC(2026, 0, 2), standing: true }) as string
    assert.match(auto, /^granted: db_read by standing approval, 2026-01-02T00:00:00\.000Z$/m)
    assert.deepEqual([(parseKagelet('x', auto) as Kagelet).standing, (parseKagelet('x', auto) as Kagelet).tools], [true, ['WebSearch', 'db_read']])
    const card = kageletFile({ ...f, tools: ['db_read'], granted: 1 }) as string
    assert.equal((parseKagelet('x', card) as Kagelet).standing, undefined)
  })
  test('revoking takes db_read out of every kagelet that got it by the standing approval, and leaves the rest', () => {
    const auto = kageletFile({ ...f, tools: ['WebSearch', 'db_read'], granted: 1, standing: true }) as string
    const card = kageletFile({ ...f, tools: ['db_read'], granted: 1 }) as string
    const web = kageletFile({ ...f, tools: ['WebSearch'] }) as string
    const out = revokeStanding([{ name: 'a', text: auto }, { name: 'b', text: card }, { name: 'c', text: web }, { name: 'd', text: auto.replace('WebSearch, ', '') }])
    assert.deepEqual(out.map(o => o.name), ['a', 'd'])
    for (const o of out) {
      const k = parseKagelet(o.name, o.text) as Kagelet
      assert.ok(!('error' in k), o.text)
      assert.deepEqual([k.tools.includes('db_read'), k.granted, k.standing, k.job], [false, undefined, undefined, 'Count failed calls.'])
    }
    assert.deepEqual((parseKagelet('a', out[0]!.text) as Kagelet).tools, ['WebSearch'])
  })
})

describe('the cost caps (#96)', () => {
  const row = (name: string, costToday: number, state: KageletRow['state'] = 'runs'): KageletRow => ({ name, state, key: `C1:1.1#side-kagelet-${name}`, tools: [], costToday, avg7: 0 })
  const caps = { each: 2, total: 10 }
  test('no cap set: nothing pauses and no DM, whatever is spent; one cap set works alone', () => {
    const rows = [row('a', 50), row('b', 70)]
    assert.deepEqual(capCheck(rows, {}, [], 'Kage'), { pause: [], tell: [] })
    assert.deepEqual(capCheck(rows, { total: 130 }, [], 'Kage').pause, [])
    assert.deepEqual(capCheck(rows, { each: 60 }, [], 'Kage').pause.map(p => p.name), ['b'])
  })
  test('a kagelet at its own cap pauses, with a DM each time', () => {
    const r = capCheck([row('dear', 2), row('cheap', 0.4), row('held', 5, 'paused')], caps, [], 'Kage')
    assert.deepEqual(r.pause.map(p => p.name), ['dear'])
    assert.match(r.pause[0]!.why, /^paused: it spent \$2\.00 today, at or over its daily cap of \$2\.00 \(KAGE_KAGELET_DAILY_USD\)$/)
    assert.deepEqual(r.tell.map(t => t.id), [undefined])
    assert.match(r.tell[0]!.text, /dear.*Kage/)
  })
  test('all kagelets together at the total cap pause every running one, with one DM a day', () => {
    const rows = [row('a', 1.5), row('b', 1.9), row('c', 7, 'paused'), row('d', 0, 'broken')]
    const r = capCheck(rows, caps, [], 'Kage')
    assert.deepEqual(r.pause.map(p => p.name), ['a', 'b'])
    assert.match(r.pause[0]!.why, /^paused: it spent \$1\.50 today.*together spent \$10\.40.*total daily cap of \$10\.00 \(KAGE_KAGELET_TOTAL_DAILY_USD\)/)
    assert.deepEqual(r.tell.map(t => t.id), ['total'])
    assert.deepEqual(capCheck(rows, caps, ['total'], 'Kage').tell, [])
    // Exactly at it pauses too.
    assert.deepEqual(capCheck([row('a', 4), row('b', 6)], caps, [], 'Kage').pause.map(p => p.name), ['a', 'b'])
    // Below it, nothing pauses.
    assert.deepEqual(capCheck([row('a', 1), row('b', 1)], caps, [], 'Kage').pause, [])
  })
  test('at 80% of either cap, one warning a day, not more', () => {
    const r = capCheck([row('a', 1.6), row('b', 1.59)], { each: 2, total: 3.9 }, [], 'Kage')
    assert.deepEqual(r.pause, [])
    assert.deepEqual(r.tell.map(t => t.id), ['a', 'total-80'])
    assert.match(r.tell[0]!.text, /a.*\$1\.60.*80%.*\$2\.00/)
    assert.deepEqual(capCheck([row('a', 1.7), row('b', 1.59)], { each: 2, total: 3.9 }, ['a', 'total-80'], 'Kage').tell, [])
  })
  test('a run\'s budget is what is left under the lower of the two caps, never zero', () => {
    // Its own cap binds for a, the total for c.
    const rows = [row('a', 0.5), row('b', 7.7), row('c', 0, 'paused')]
    assert.equal(budgetLeft(rows, 'C1:1.1#side-kagelet-a', caps), 1.5)
    assert.equal(budgetLeft(rows, 'C1:1.1#side-kagelet-c', caps), 1.8)
    assert.equal(budgetLeft([row('a', 3)], 'C1:1.1#side-kagelet-a', caps), 0.01)
    // No cap set: no budget, so no run is stopped.
    assert.equal(budgetLeft(rows, 'C1:1.1#side-kagelet-a', {}), undefined)
    assert.equal(budgetLeft(rows, 'C1:1.1#side-kagelet-a', { total: 10 }), 1.8)
  })
})

describe('cost monitoring (#96)', () => {
  const now = new Date(2026, 10, 14, 15, 0).getTime()
  const at = (d: number, h: number, m = 0) => new Date(2026, 10, d, h, m).toISOString()
  const lane = (n: string) => `CTEST1:1700000000.123456#side-kagelet-${n}`
  const files = ['spiky', 'steady', 'fresh', 'gaps', 'busy'].map(name => ({ name, text: file(`thread: ${LINK}\nschedule: 0 9 * * *`) }))
  // spiky and steady spent $0.10 a day for the 7 days before today, busy $0.30; one row 8 days ago does not count.
  const history = [7, 8, 9, 10, 11, 12, 13].flatMap(d => ['spiky', 'steady', 'busy'].map(n => `${at(d, 9)}\t${lane(n)}\t${n === 'busy' ? 0.3 : 0.1}\t0\n`)).join('') + `${at(6, 9)}\t${lane('spiky')}\t5\t0\n`
  const today = `${at(14, 9, 1)}\t${lane('spiky')}\t0.61\t0\n${at(14, 9, 1)}\t${lane('steady')}\t0.25\t0\n${at(14, 9, 1)}\t${lane('fresh')}\t0.45\t0\n${at(14, 10, 1)}\t${lane('gaps')}\t0.05\t0\n${at(14, 9, 1)}\t${lane('busy')}\t0.8\t0\n`
  // gaps ran at 9 (no costs row), 10 (one) and 14:30 (still running, under an hour).
  const runs = [9, 10].map(h => `${at(14, h)}\tkagelet-gaps\t${lane('gaps')}\n`).join('') + `${at(14, 14, 30)}\tkagelet-gaps\t${lane('gaps')}\n`
  const costs = history + today
  const rows = kageletRows(files, { runs, costs, now })
  test('each row has its 7-day daily average', () => {
    assert.deepEqual(rows.map(r => [r.name, r.avg7]), [['busy', 0.3], ['fresh', 0], ['gaps', 0], ['spiky', 0.1], ['steady', 0.1]])
  })
  test('flags a kagelet over 3x its 7-day average and over the floor, and a finished run with no costs row', () => {
    const flags = costFlags(rows, { runs, costs, reports: '' }, now)
    assert.deepEqual(flags.map(f => f.name), ['gaps', 'spiky'])
    assert.match(flags[0]!.line, /gaps: its 09:00 run wrote no costs row/)
    assert.match(flags[1]!.line, /spiky: spent \$0\.61 today, over 3x its 7-day average of \$0\.10/)
  })
  test('at most one flag line per kagelet a day', () => {
    const said = `${at(14, 11)}\tcost:spiky\tx\t\n${at(13, 11)}\tcost:gaps\tx\t\n`
    assert.deepEqual(costFlags(rows, { runs, costs, reports: said }, now).map(f => f.name), ['gaps'])
  })
})

describe('chains (#93): after: <kagelet> runs a kagelet on another one\'s output', () => {
  const k = (name: string, after?: string) => ({ name, ...(after && { after }) })
  test('a file may name the kagelet it runs after, and then needs no schedule', () => {
    const sp = parseKagelet('edit', file(`thread: ${LINK}\nafter: make\ntools: WebFetch`))
    assert.ok(!('error' in sp))
    assert.equal(sp.after, 'make')
    assert.equal(sp.cron, '')
    assert.match((parseKagelet('edit', file(`thread: ${LINK}\nafter: Make Videos`)) as { error: string }).error, /after must name a kagelet/)
    assert.match((parseKagelet('edit', file(`thread: ${LINK}`)) as { error: string }).error, /schedule must be a cron line/)
  })
  test('refused: a missing kagelet, a cycle, a chain deeper than 5', () => {
    assert.deepEqual([...chainErrors([k('a'), k('b', 'a'), k('c', 'b')])], [])
    assert.match(chainErrors([k('b', 'gone')]).get('b')!, /no kagelet named "gone"/)
    const cycle = chainErrors([k('a', 'c'), k('b', 'a'), k('c', 'b'), k('d', 'c')])
    assert.deepEqual([...cycle.keys()].sort(), ['a', 'b', 'c', 'd'])
    assert.match(cycle.get('a')!, /cycle/)
    assert.match(chainErrors([k('a', 'a')]).get('a')!, /cycle/)
    const five = [k('a'), k('b', 'a'), k('c', 'b'), k('d', 'c'), k('e', 'd')]
    assert.deepEqual([...chainErrors(five)], [])
    assert.match(chainErrors([...five, k('f', 'e')]).get('f')!, /6 steps deep, more than 5/)
  })
  test('the manager\'s file keeps after, and a schedule only when it has one', () => {
    const text = kageletFile({ thread: LINK, schedule: '', after: 'make', tools: ['WebFetch'], job: 'Trim it.', by: 'kage', why: 'w' })
    assert.equal(typeof text, 'string')
    assert.match(text as string, /^after: make$/m)
    assert.doesNotMatch(text as string, /^schedule:/m)
  })
})

test('a kagelet whose after: line cannot run shows as broken with the reason', () => {
  const f = (name: string, after: string) => ({ name, text: file(`thread: ${LINK}\nafter: ${after}`) })
  const rows = kageletRows([f('a', 'b'), f('b', 'a'), f('c', 'gone')], { runs: '', costs: '', now: 0 })
  assert.deepEqual(rows.map(r => [r.name, r.state]), [['a', 'broken'], ['b', 'broken'], ['c', 'broken']])
  assert.match(rows[2]!.error!, /no kagelet named "gone"/)
})
