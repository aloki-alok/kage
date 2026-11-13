import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openStore } from './store.ts'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { costCap, ownerNotes, pauseSpecialist, readSpecialists, specialistManager, syncSpecialists } from './specialists.ts'

const LINK = 'https://test.slack.com/archives/CTEST1/p1700000000123456'
const KEY = 'CTEST1:1700000000.123456#side-spec-deploys'
const file = (cron = '0 9 * * 1-5', tools = 'Read') => ({ name: 'deploys', text: `---\nthread: ${LINK}\nschedule: ${cron}\ntools: ${tools}\n---\nSummarise the deploy log.\n` })

test('each specialist file becomes one recurring schedule in its lane, at teammate trust, with its grant', () => {
  const store = openStore(':memory:')
  const logs: string[] = []
  const grants = syncSpecialists([file()], store, 1000, l => logs.push(l))
  assert.deepEqual([...grants], [[KEY, ['Read']]])
  const [s] = store.schedules()
  assert.equal(s!.id, 'spec-deploys')
  assert.equal(s!.key, KEY)
  assert.equal(s!.cron, '0 9 * * 1-5')
  assert.equal(s!.recurring, true)
  assert.equal(s!.fromOwner, false)
  assert.match(s!.prompt, /approve nothing[\s\S]*Summarise the deploy log\./)
  assert.equal(store.conversation(KEY)?.conversation.chat, 'CTEST1')   // the scheduler can find its thread
})

test('a second sync with no change keeps the schedule and when it last ran; a change replaces it; a removed file removes it', () => {
  const store = openStore(':memory:')
  syncSpecialists([file()], store, 1000, () => {})
  store.fired('spec-deploys', 5000)
  syncSpecialists([file()], store, 9000, () => {})
  assert.equal(store.schedules()[0]!.lastFired, 5000)
  assert.equal(store.schedules()[0]!.created, 1000)
  syncSpecialists([file('0 10 * * *')], store, 9000, () => {})
  assert.equal(store.schedules()[0]!.cron, '0 10 * * *')
  assert.equal(store.schedules()[0]!.lastFired, 5000)
  // A schedule the specialist added in its own lane goes with it.
  store.addSchedule({ id: 'ab12cd34', key: KEY, cron: '0 * * * *', prompt: 'x', recurring: true, fromOwner: false, created: 0, lastFired: 0 })
  const grants = syncSpecialists([], store, 9000, () => {})
  assert.deepEqual(store.schedules(), [])
  assert.equal(grants.size, 0)
})

test('a wrong file runs nothing, and its reason is logged once until it changes', () => {
  const store = openStore(':memory:')
  const logs: string[] = []
  const bad = { name: 'deploys', text: 'no front matter' }
  syncSpecialists([bad], store, 1000, l => logs.push(l))
  syncSpecialists([bad], store, 2000, l => logs.push(l))
  assert.equal(logs.length, 1)
  assert.match(logs[0]!, /deploys.*front matter/)
  assert.deepEqual(store.schedules(), [])
})

test('other schedules in the store are left alone', () => {
  const store = openStore(':memory:')
  store.addSchedule({ id: 'job1', key: 'C1:5.5', cron: '0 9 * * *', prompt: 'x', recurring: true, fromOwner: true, created: 0, lastFired: 0 })
  syncSpecialists([], store, 1000, () => {})
  assert.deepEqual(store.schedules().map(s => s.id), ['job1'])
})

test('a paused specialist keeps its grant but has no schedule; resumed, it waits for its next time instead of running at once', () => {
  const store = openStore(':memory:')
  syncSpecialists([file()], store, 1000, () => {})
  const paused = { name: 'deploys', text: file().text.replace('---\nSummarise', 'paused: yes\n---\nSummarise') }
  const grants = syncSpecialists([paused], store, 2000, () => {})
  assert.deepEqual(store.schedules(), [])
  assert.deepEqual([...grants], [[KEY, ['Read']]])
  syncSpecialists([file()], store, 3000, () => {})
  assert.equal(store.schedules()[0]!.created, 3000)
})

test('the folder reads as name and text per .md file, and a missing folder as none', () => {
  const dir = mkdtempSync(`${tmpdir()}/spec-`)
  writeFileSync(`${dir}/deploys.md`, 'x')
  writeFileSync(`${dir}/notes.txt`, 'y')
  assert.deepEqual(readSpecialists(dir), [{ name: 'deploys', text: 'x' }])
  assert.deepEqual(readSpecialists(`${dir}/none`), [])
  mkdirSync(`${dir}/folder.md`)   // one that cannot be read is left out, not the whole list
  assert.deepEqual(readSpecialists(dir), [{ name: 'deploys', text: 'x' }])
})

test('pausing by name rewrites only that file, keeps it, and says when nothing matches', () => {
  const dir = mkdtempSync(`${tmpdir()}/spec-`)
  writeFileSync(`${dir}/deploys.md`, file().text)
  assert.match(pauseSpecialist(dir, 'deploys', true), /paused/)
  assert.match(readFileSync(`${dir}/deploys.md`, 'utf8'), /^paused: yes$/m)
  assert.match(pauseSpecialist(dir, 'deploys', true), /already paused/)
  assert.match(pauseSpecialist(dir, 'deploys', false, Date.UTC(2026, 10, 14)), /runs again/)
  // A resume stamps its time (the daily cost cap counts from it); nothing else changes.
  assert.equal(readFileSync(`${dir}/deploys.md`, 'utf8'), file().text.replace('---\nSummarise', 'resumed: 2026-11-14T00:00:00.000Z\n---\nSummarise'))
  assert.match(pauseSpecialist(dir, 'nobody', true), /no specialist/i)
  // A name that steps out of the folder is refused even when the file there exists.
  mkdirSync(`${dir}/in`)
  writeFileSync(`${dir}/out.md`, file().text)
  assert.match(pauseSpecialist(`${dir}/in`, '../out', true), /no specialist/i)
  assert.equal(readFileSync(`${dir}/out.md`, 'utf8'), file().text)
})

test('no more than the cap run: past it, a specialist is logged and gets no schedule and no grant', () => {
  const store = openStore(':memory:')
  const logs: string[] = []
  const two = (name: string) => ({ name, text: file().text })
  const held = { name: 'aa', text: file().text.replace('---\nSummarise', 'paused: yes\n---\nSummarise') }
  // Name order, whatever order the folder gives; a paused one does not count.
  const grants = syncSpecialists([two('c'), two('b'), held, two('a')], store, 1000, l => logs.push(l), 2)
  assert.deepEqual(store.schedules().map(s => s.id).sort(), ['spec-a', 'spec-b'])
  // The paused one keeps its grant, as any paused one does; the one past the cap has none.
  assert.deepEqual([...grants.keys()].map(k => k.split('#side-spec-')[1]).sort(), ['a', 'aa', 'b'])
  assert.match(logs.join('\n'), /c does not run: .*2 specialists/)
})

function manager(max = 10) {
  const dir = mkdtempSync(`${tmpdir()}/spec-`)
  const ran: string[] = [], synced: number[] = []
  const reports: string[] = []
  const m = specialistManager({
    dir, max, ledgers: { text: (n: string) => n === 'reports' ? reports.join('') : '' },
    sync: now => { synced.push(now) },
    runNow: id => { ran.push(id); return undefined },
  })
  return { dir, m, ran, synced, reports }
}
const job = { thread: LINK, schedule: '0 9 * * *', tools: ['WebSearch'], job: 'Check the status page.', by: 'kage' as const, why: 'a daily check the owner asked for twice' }

test('the manager saves a specialist file the hub syncs at once, and lists who made it and why', () => {
  const t = manager()
  assert.match(t.m.manage({ action: 'save', name: 'status', ...job }, 5000), /saved status/i)
  assert.deepEqual(t.synced, [5000])
  const sp = readFileSync(`${t.dir}/status.md`, 'utf8')
  assert.match(sp, /^by: kage$/m)
  const list = t.m.list(5000)
  assert.match(list, /status\s+runs/)
  assert.match(list, /made by Kage: a daily check the owner asked for twice/)
  assert.match(list, /no report yet/)
})

test('the manager is refused a new specialist past the cap, a tool v1 cannot grant, and a wider grant for one it makes itself', () => {
  const t = manager(1)
  t.m.manage({ action: 'save', name: 'one', ...job }, 1)
  assert.match(t.m.manage({ action: 'save', name: 'two', ...job }, 1), /at most 1/)
  // Changing one that exists is not a new one.
  assert.match(t.m.manage({ action: 'save', name: 'one', ...job, schedule: '0 10 * * *' }, 1), /saved one/i)
  const u = manager()
  assert.match(u.m.manage({ action: 'save', name: 'x', ...job, tools: ['Bash'] }, 1), /not Bash/)
  assert.match(u.m.manage({ action: 'save', name: 'x', ...job, tools: ['mcp__docs__read'] }, 1), /owner/)
  assert.match(u.m.manage({ action: 'save', name: 'x', ...job, by: 'owner', tools: ['mcp__docs__read'] }, 1), /saved x/i)
  assert.match(u.m.manage({ action: 'save', name: '../x', ...job }, 1), /name/)
  // A change that leaves out by keeps who made it.
  const { by: _, ...noBy } = job
  u.m.manage({ action: 'save', name: 'x', ...noBy, tools: ['WebSearch'] }, 2)
  assert.match(readFileSync(`${u.dir}/x.md`, 'utf8'), /^by: owner$/m)
})

test('the manager pauses, resumes, runs now and removes; a paused one does not run now', () => {
  const t = manager()
  t.m.manage({ action: 'save', name: 'status', ...job }, 1)
  assert.match(t.m.manage({ action: 'run', name: 'status' }, 2), /running now/)
  assert.deepEqual(t.ran, ['spec-status'])
  assert.match(t.m.manage({ action: 'pause', name: 'status' }, 3), /paused/)
  assert.match(t.m.manage({ action: 'run', name: 'status' }, 4), /paused/)
  assert.deepEqual(t.ran, ['spec-status'])
  assert.match(t.m.manage({ action: 'resume', name: 'status' }, 5), /runs again/)
  assert.match(t.m.manage({ action: 'remove', name: 'status' }, 6), /removed/)
  assert.equal(existsSync(`${t.dir}/status.md`), false)
  assert.match(t.m.manage({ action: 'remove', name: 'status' }, 7), /no specialist/i)
})

test('a specialist over its daily cost cap is paused and flagged for the manager; one under it runs on', () => {
  const dir = mkdtempSync(`${tmpdir()}/spec-`)
  writeFileSync(`${dir}/dear.md`, file().text)
  writeFileSync(`${dir}/cheap.md`, file().text)
  writeFileSync(`${dir}/edge.md`, file().text)
  const flags: string[] = []
  const rows = [
    { name: 'dear', state: 'runs' as const, tools: [], costToday: 2.1 },
    { name: 'cheap', state: 'runs' as const, tools: [], costToday: 0.4 },
    { name: 'edge', state: 'runs' as const, tools: [], costToday: 2 },
    { name: 'held', state: 'paused' as const, tools: [], costToday: 9 },
  ]
  assert.deepEqual(costCap(dir, rows, 2, (name, why) => flags.push(`${name}: ${why}`)), ['dear', 'edge'])
  assert.match(readFileSync(`${dir}/dear.md`, 'utf8'), /^paused: yes$/m)
  assert.doesNotMatch(readFileSync(`${dir}/cheap.md`, 'utf8'), /paused/)
  assert.equal(flags.length, 2)
  assert.match(flags[0]!, /dear: .*\$2\.10.*\$2\.00/)
})

test('the owner\'s words in a specialist\'s thread reach its next run once, and only that thread\'s specialists', () => {
  const store = openStore(':memory:')
  const notes = ownerNotes(store)
  const lanes = [KEY, 'CTEST2:1.1#side-spec-other']
  notes.wrote(lanes, 'CTEST1', '1700000000.123456', 'skip the staging log today')
  notes.wrote(lanes, 'CTEST9', '5.5', 'not for any specialist')
  // A run that could not be delivered keeps them for the next one.
  assert.match(notes.take(KEY, () => false) ?? '', /skip the staging log today/)
  assert.match(notes.take(KEY, () => true) ?? '', /owner wrote[\s\S]*skip the staging log today/)
  assert.equal(notes.take(KEY, () => true), undefined)
  assert.equal(notes.take('CTEST2:1.1#side-spec-other', () => true), undefined)
})
