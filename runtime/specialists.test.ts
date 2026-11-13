import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openStore } from './store.ts'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { pauseSpecialist, readSpecialists, syncSpecialists } from './specialists.ts'

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
})

test('pausing by name rewrites only that file, keeps it, and says when nothing matches', () => {
  const dir = mkdtempSync(`${tmpdir()}/spec-`)
  writeFileSync(`${dir}/deploys.md`, file().text)
  assert.match(pauseSpecialist(dir, 'deploys', true), /paused/)
  assert.match(readFileSync(`${dir}/deploys.md`, 'utf8'), /^paused: yes$/m)
  assert.match(pauseSpecialist(dir, 'deploys', true), /already paused/)
  assert.match(pauseSpecialist(dir, 'deploys', false), /runs again/)
  assert.equal(readFileSync(`${dir}/deploys.md`, 'utf8'), file().text)
  assert.match(pauseSpecialist(dir, 'nobody', true), /no specialist/i)
  assert.match(pauseSpecialist(dir, '../env', true), /no specialist/i)
})
