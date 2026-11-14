import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openStore } from './store.ts'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { costCap, kageletManager, readCommand, kageletsDir, ownerNotes, pauseKagelet, readKagelets, syncKagelets } from './kagelets.ts'

const LINK = 'https://test.slack.com/archives/CTEST1/p1700000000123456'
const KEY = 'CTEST1:1700000000.123456#side-kagelet-deploys'
const file = (cron = '0 9 * * 1-5', tools = 'Read') => ({ name: 'deploys', text: `---\nthread: ${LINK}\nschedule: ${cron}\ntools: ${tools}\n---\nSummarise the deploy log.\n` })

test('each kagelet file becomes one recurring schedule in its lane, at teammate trust, with its grant', () => {
  const store = openStore(':memory:')
  const logs: string[] = []
  const grants = syncKagelets([file()], store, 1000, l => logs.push(l))
  assert.deepEqual([...grants], [[KEY, ['Read']]])
  const [s] = store.schedules()
  assert.equal(s!.id, 'kagelet-deploys')
  assert.equal(s!.key, KEY)
  assert.equal(s!.cron, '0 9 * * 1-5')
  assert.equal(s!.recurring, true)
  assert.equal(s!.fromOwner, false)
  assert.match(s!.prompt, /approve nothing[\s\S]*Summarise the deploy log\./)
  assert.equal(store.conversation(KEY)?.conversation.chat, 'CTEST1')   // the scheduler can find its thread
})

test('a second sync with no change keeps the schedule and when it last ran; a change replaces it; a removed file removes it', () => {
  const store = openStore(':memory:')
  syncKagelets([file()], store, 1000, () => {})
  store.fired('kagelet-deploys', 5000)
  syncKagelets([file()], store, 9000, () => {})
  assert.equal(store.schedules()[0]!.lastFired, 5000)
  assert.equal(store.schedules()[0]!.created, 1000)
  syncKagelets([file('0 10 * * *')], store, 9000, () => {})
  assert.equal(store.schedules()[0]!.cron, '0 10 * * *')
  assert.equal(store.schedules()[0]!.lastFired, 5000)
  // A schedule the kagelet added in its own lane goes with it.
  store.addSchedule({ id: 'ab12cd34', key: KEY, cron: '0 * * * *', prompt: 'x', recurring: true, fromOwner: false, created: 0, lastFired: 0 })
  const grants = syncKagelets([], store, 9000, () => {})
  assert.deepEqual(store.schedules(), [])
  assert.equal(grants.size, 0)
})

test('a wrong file runs nothing, and its reason is logged once until it changes', () => {
  const store = openStore(':memory:')
  const logs: string[] = []
  const bad = { name: 'deploys', text: 'no front matter' }
  syncKagelets([bad], store, 1000, l => logs.push(l))
  syncKagelets([bad], store, 2000, l => logs.push(l))
  assert.equal(logs.length, 1)
  assert.match(logs[0]!, /deploys.*front matter/)
  assert.deepEqual(store.schedules(), [])
})

test('other schedules in the store are left alone', () => {
  const store = openStore(':memory:')
  store.addSchedule({ id: 'job1', key: 'C1:5.5', cron: '0 9 * * *', prompt: 'x', recurring: true, fromOwner: true, created: 0, lastFired: 0 })
  syncKagelets([], store, 1000, () => {})
  assert.deepEqual(store.schedules().map(s => s.id), ['job1'])
})

test('a paused kagelet keeps its grant but has no schedule; resumed, it waits for its next time instead of running at once', () => {
  const store = openStore(':memory:')
  syncKagelets([file()], store, 1000, () => {})
  const paused = { name: 'deploys', text: file().text.replace('---\nSummarise', 'paused: yes\n---\nSummarise') }
  const grants = syncKagelets([paused], store, 2000, () => {})
  assert.deepEqual(store.schedules(), [])
  assert.deepEqual([...grants], [[KEY, ['Read']]])
  syncKagelets([file()], store, 3000, () => {})
  assert.equal(store.schedules()[0]!.created, 3000)
})

test('the folder reads as name and text per .md file, and a missing folder as none', () => {
  const dir = mkdtempSync(`${tmpdir()}/spec-`)
  writeFileSync(`${dir}/deploys.md`, 'x')
  writeFileSync(`${dir}/notes.txt`, 'y')
  assert.deepEqual(readKagelets(dir), [{ name: 'deploys', text: 'x' }])
  assert.deepEqual(readKagelets(`${dir}/none`), [])
  mkdirSync(`${dir}/folder.md`)   // one that cannot be read is left out, not the whole list
  assert.deepEqual(readKagelets(dir), [{ name: 'deploys', text: 'x' }])
})

test('pausing by name rewrites only that file, keeps it, and says when nothing matches', () => {
  const dir = mkdtempSync(`${tmpdir()}/spec-`)
  writeFileSync(`${dir}/deploys.md`, file().text)
  assert.match(pauseKagelet(dir, 'deploys', true), /paused/)
  assert.match(readFileSync(`${dir}/deploys.md`, 'utf8'), /^paused: yes$/m)
  assert.match(pauseKagelet(dir, 'deploys', true), /already paused/)
  assert.match(pauseKagelet(dir, 'deploys', false, Date.UTC(2026, 10, 14)), /runs again/)
  // A resume stamps its time (the daily cost cap counts from it); nothing else changes.
  assert.equal(readFileSync(`${dir}/deploys.md`, 'utf8'), file().text.replace('---\nSummarise', 'resumed: 2026-11-14T00:00:00.000Z\n---\nSummarise'))
  assert.match(pauseKagelet(dir, 'nobody', true), /no kagelet/i)
  // A name that steps out of the folder is refused even when the file there exists.
  mkdirSync(`${dir}/in`)
  writeFileSync(`${dir}/out.md`, file().text)
  assert.match(pauseKagelet(`${dir}/in`, '../out', true), /no kagelet/i)
  assert.equal(readFileSync(`${dir}/out.md`, 'utf8'), file().text)
})

test('no more than the cap run: past it, a kagelet is logged and gets no schedule and no grant', () => {
  const store = openStore(':memory:')
  const logs: string[] = []
  const two = (name: string) => ({ name, text: file().text })
  const held = { name: 'aa', text: file().text.replace('---\nSummarise', 'paused: yes\n---\nSummarise') }
  // Name order, whatever order the folder gives; a paused one does not count.
  const grants = syncKagelets([two('c'), two('b'), held, two('a')], store, 1000, l => logs.push(l), 2)
  assert.deepEqual(store.schedules().map(s => s.id).sort(), ['kagelet-a', 'kagelet-b'])
  // The paused one keeps its grant, as any paused one does; the one past the cap has none.
  assert.deepEqual([...grants.keys()].map(k => k.split('#side-kagelet-')[1]).sort(), ['a', 'aa', 'b'])
  assert.match(logs.join('\n'), /c does not run: .*2 kagelets/)
})

function manager(max = 10, envCommand?: string) {
  const dir = mkdtempSync(`${tmpdir()}/spec-`)
  const ran: string[] = [], synced: number[] = [], logs: string[] = [], grants: string[][] = []
  const reports: string[] = []
  const store = openStore(':memory:')
  const m = kageletManager({
    dir, max, ledgers: { text: (n: string) => n === 'reports' ? reports.join('') : '', add: (n, cells) => { if (n === 'grants') grants.push(cells) } },
    sync: now => { synced.push(now) },
    runNow: id => { ran.push(id); return undefined },
    store, envCommand, log: l => logs.push(l),
  })
  return { dir, m, ran, synced, reports, store, logs, grants }
}
const job = { thread: LINK, schedule: '0 9 * * *', tools: ['WebSearch'], job: 'Check the status page.', by: 'kage' as const, why: 'a daily check the owner asked for twice' }

test('the manager saves a kagelet file the hub syncs at once, and lists who made it and why', async () => {
  const t = manager()
  assert.match(await t.m.manage({ action: 'save', name: 'status', ...job }, 5000), /saved status/i)
  assert.deepEqual(t.synced, [5000])
  const sp = readFileSync(`${t.dir}/status.md`, 'utf8')
  assert.match(sp, /^by: kage$/m)
  const list = t.m.list(5000)
  assert.match(list, /status\s+runs/)
  assert.match(list, /made by Kage: a daily check the owner asked for twice/)
  assert.match(list, /no report yet/)
})

test('the manager is refused a new kagelet past the cap, a tool v1 cannot grant, and a wider grant for one it makes itself', async () => {
  const t = manager(1)
  await t.m.manage({ action: 'save', name: 'one', ...job }, 1)
  assert.match(await t.m.manage({ action: 'save', name: 'two', ...job }, 1), /at most 1/)
  // Changing one that exists is not a new one.
  assert.match(await t.m.manage({ action: 'save', name: 'one', ...job, schedule: '0 10 * * *' }, 1), /saved one/i)
  const u = manager()
  assert.match(await u.m.manage({ action: 'save', name: 'x', ...job, tools: ['Bash'] }, 1), /not Bash/)
  assert.match(await u.m.manage({ action: 'save', name: 'x', ...job, tools: ['mcp__docs__read'] }, 1), /owner/)
  assert.match(await u.m.manage({ action: 'save', name: 'x', ...job, by: 'owner', tools: ['mcp__docs__read'] }, 1), /saved x/i)
  assert.match(await u.m.manage({ action: 'save', name: '../x', ...job }, 1), /name/)
  // A change that leaves out by keeps who made it.
  const { by: _, ...noBy } = job
  await u.m.manage({ action: 'save', name: 'x', ...noBy, tools: ['WebSearch'] }, 2)
  assert.match(readFileSync(`${u.dir}/x.md`, 'utf8'), /^by: owner$/m)
})

// The owner's answer to the approval card, and every card it was shown.
const owner = (yes: boolean) => {
  const cards: Record<string, string>[] = []
  return { cards, ask: async (c: Record<string, string>) => { cards.push(c); return yes } }
}
const calls = { ...job, by: 'kage' as const, tools: ['WebSearch', 'db_read'], job: 'Count failed calls.\nPost the count.', read_command: '~/bin/read-sql --ro' }

test('db_read is saved only on the owner\'s yes to a card that names the kagelet, its job and the read command', async () => {
  const no = manager(), o = owner(false)
  assert.match(await no.m.manage({ action: 'save', name: 'calls', ...calls }, 1, o.ask), /not saved: the owner did not approve db_read/)
  assert.deepEqual(Object.entries(o.cards[0]!), [['kagelet', 'calls'], ['read_command', '~/bin/read-sql --ro'], ['job', 'Count failed calls.']])
  assert.equal(readKagelets(no.dir).length, 0)
  assert.equal(readCommand(undefined, no.store), undefined)
  assert.deepEqual(no.grants.map(g => g.slice(0, 2)), [['calls', 'refused']])
  assert.match(no.logs.join('\n'), /kagelet calls: db_read refused: the owner did not approve/)

  const yes = manager(), y = owner(true)
  assert.match(await yes.m.manage({ action: 'save', name: 'calls', ...calls }, Date.UTC(2026, 0, 2), y.ask), /saved calls/)
  assert.match(readFileSync(`${yes.dir}/calls.md`, 'utf8'), /^granted: db_read by the owner, 2026-01-02T00:00:00\.000Z$/m)
  // Kept in the hub's store, where the db_read tool reads it on each call.
  assert.equal(readCommand(undefined, yes.store), '~/bin/read-sql --ro')
  assert.deepEqual(yes.grants.map(g => g.slice(0, 2)), [['calls', 'granted']])
  assert.match(yes.logs.join('\n'), /kagelet calls: db_read granted by the owner/)
  // The ledger and the log name the kagelet and the outcome, never the command.
  assert.doesNotMatch(JSON.stringify(yes.grants) + yes.logs.join(''), /read-sql/)
})

test('a db_read save with no way to ask the owner, or no read command, is refused before any card', async () => {
  const t = manager(), o = owner(true)
  assert.match(await t.m.manage({ action: 'save', name: 'calls', ...calls }, 1), /not saved: .*owner/)
  const { read_command: _, ...noCommand } = calls
  assert.match(await t.m.manage({ action: 'save', name: 'calls', ...noCommand }, 1, o.ask), /not saved: .*read_command/)
  // A file that would not run is refused before the owner is asked.
  assert.match(await t.m.manage({ action: 'save', name: 'calls', ...calls, schedule: 'daily' }, 1, o.ask), /not saved: schedule/)
  assert.deepEqual(o.cards, [])
  assert.equal(readKagelets(t.dir).length, 0)
  assert.deepEqual(t.grants.map(g => g.slice(0, 2)), [['calls', 'refused'], ['calls', 'refused'], ['calls', 'refused']])
})

test('KAGE_DB_READ_COMMAND wins over a proposed command: the card names it without its text, and the store keeps nothing', async () => {
  const t = manager(10, 'env-read --password=x'), o = owner(true)
  assert.match(await t.m.manage({ action: 'save', name: 'calls', ...calls }, 1, o.ask), /saved calls/)
  assert.match(o.cards[0]!.read_command!, /^KAGE_DB_READ_COMMAND/)
  assert.doesNotMatch(JSON.stringify(o.cards), /password/)
  assert.equal(t.store.load('db-read-command'), undefined)
  assert.equal(readCommand('env-read', t.store), 'env-read')
  // Once approved, a later grant may use the stored command without proposing one.
  const u = manager(), y = owner(true)
  await u.m.manage({ action: 'save', name: 'calls', ...calls }, 1, y.ask)
  const { read_command: _, ...noCommand } = calls
  assert.match(await u.m.manage({ action: 'save', name: 'other', ...noCommand }, 2, y.ask), /saved other/)
  assert.equal(y.cards[1]!.read_command, '~/bin/read-sql --ro')
  assert.equal(readCommand('env-read', u.store), 'env-read')
})

test('the manager pauses, resumes, runs now and removes; a paused one does not run now', async () => {
  const t = manager()
  await t.m.manage({ action: 'save', name: 'status', ...job }, 1)
  assert.match(await t.m.manage({ action: 'run', name: 'status' }, 2), /running now/)
  assert.deepEqual(t.ran, ['kagelet-status'])
  assert.match(await t.m.manage({ action: 'pause', name: 'status' }, 3), /paused/)
  assert.match(await t.m.manage({ action: 'run', name: 'status' }, 4), /paused/)
  assert.deepEqual(t.ran, ['kagelet-status'])
  assert.match(await t.m.manage({ action: 'resume', name: 'status' }, 5), /runs again/)
  assert.match(await t.m.manage({ action: 'remove', name: 'status' }, 6), /removed/)
  assert.equal(existsSync(`${t.dir}/status.md`), false)
  assert.match(await t.m.manage({ action: 'remove', name: 'status' }, 7), /no kagelet/i)
})

test('a kagelet over its daily cost cap is paused and flagged for the manager; one under it runs on', () => {
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

test('the owner\'s words in a kagelet\'s thread reach its next run once, and only that thread\'s kagelets', () => {
  const store = openStore(':memory:')
  const notes = ownerNotes(store)
  const lanes = [KEY, 'CTEST2:1.1#side-kagelet-other']
  notes.wrote(lanes, 'CTEST1', '1700000000.123456', 'skip the staging log today')
  notes.wrote(lanes, 'CTEST9', '5.5', 'not for any kagelet')
  // A run that could not be delivered keeps them for the next one.
  assert.match(notes.take(KEY, () => false) ?? '', /skip the staging log today/)
  assert.match(notes.take(KEY, () => true) ?? '', /owner wrote[\s\S]*skip the staging log today/)
  assert.equal(notes.take(KEY, () => true), undefined)
  assert.equal(notes.take('CTEST2:1.1#side-kagelet-other', () => true), undefined)
})

test('a schedule from before the rename (old id and lane) moves to the new one, keeping when it last ran', () => {
  const store = openStore(':memory:')
  const OLD = 'CTEST1:1700000000.123456#side-spec-deploys'
  store.addSchedule({ id: 'spec-deploys', key: OLD, cron: '0 9 * * 1-5', prompt: 'old', recurring: true, fromOwner: false, created: 100, lastFired: 5000 })
  store.addSchedule({ id: 'ab12cd34', key: OLD, cron: '0 * * * *', prompt: 'x', recurring: true, fromOwner: false, created: 0, lastFired: 0 })
  syncKagelets([file()], store, 9000, () => {})
  assert.deepEqual(store.schedules().map(s => [s.id, s.key, s.created, s.lastFired]), [['kagelet-deploys', KEY, 100, 5000]])
})

test('only the hub moves the old folder; a kage command reads it where it is, so an old hub still running keeps its schedules', () => {
  const dir = mkdtempSync(`${tmpdir()}/kagelet-`)
  mkdirSync(`${dir}/specialists`)
  writeFileSync(`${dir}/specialists/deploys.md`, 'x')
  assert.equal(kageletsDir(dir), `${dir}/specialists`)
  assert.equal(existsSync(`${dir}/specialists/deploys.md`), true)
  const logs: string[] = []
  assert.equal(kageletsDir(dir, l => logs.push(l)), `${dir}/kagelets`)
  assert.deepEqual(readKagelets(`${dir}/kagelets`), [{ name: 'deploys', text: 'x' }])
  assert.equal(existsSync(`${dir}/specialists`), false)
  assert.equal(kageletsDir(dir), `${dir}/kagelets`)
  // Both there: the new one wins, and the hub says the old one is left.
  mkdirSync(`${dir}/specialists`)
  writeFileSync(`${dir}/specialists/other.md`, 'y')
  assert.equal(kageletsDir(dir, l => logs.push(l)), `${dir}/kagelets`)
  assert.match(logs.join('\n'), /specialists.*other\.md|1 file/)
  assert.equal(kageletsDir(mkdtempSync(`${tmpdir()}/kagelet-`), () => {}).endsWith('/kagelets'), true)
})
