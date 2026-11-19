import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { paneTurn } from '../pane-turn.ts'
import { sessionTools } from '../kage-tools.ts'
import { openLedgers } from '../ledger.ts'
import type { Task } from '../../core/task.ts'

const GUARD = new URL('../../plugin/private-data-guard.ts', import.meta.url).pathname
const TURN_END = new URL('../../plugin/turn-end.ts', import.meta.url).pathname
const tick = (ms = 80) => new Promise(r => setTimeout(r, ms))
const opened: { close?: () => void }[] = []
afterEach(() => { for (const p of opened.splice(0)) p.close?.() })

function pane() {
  const conf = mkdtempSync(join(tmpdir(), 'kage-pane-'))
  const env = { PATH: process.env.PATH!, HOME: conf, KAGE_ENV: join(conf, 'env'), KAGE_THREAD: 'C1:5.5' }
  const hook = (file: string, input: object) => execFileSync(process.execPath, [file], { input: JSON.stringify(input), env, encoding: 'utf8' })
  const slack = { chat: { postMessage: async () => ({ ts: '9.1' }) }, reactions: { add: async () => {} }, users: { info: async () => ({}) } }
  const shown: string[] = []
  let kage!: ReturnType<typeof sessionTools>
  const turn = paneTurn({ dir: conf, thread: 'C1:5.5', pollMs: 10, show: m => { kage.onTask(m); shown.push(m.content) } })
  opened.push(turn as { close?: () => void })
  kage = sessionTools({ title: 'Kage', bot: slack as any, user: slack as any, botDm: () => 'DBOT', dir: conf, ledgers: openLedgers(conf), send: () => {}, memory: { own: '/own', owner: '/owner' }, turnSender: turn.sender })
  const task = (fromOwner: boolean, content: string): Task => ({ type: 'task', content, fromOwner, meta: { channel: 'C1', thread_ts: '5.5', place: '#infra', permalink: '' }, origin: { channel: 'C1', ts: `${shown.length + 1}.0` } })
  return {
    shown,
    owner: (text: string) => turn.arrive(task(true, `Task from the owner: ${text}`)),
    teammate: (text: string) => turn.arrive(task(false, `Task from Sam: ${text}`)),
    configOpen: () => !hook(GUARD, { tool_name: 'Read', tool_input: { file_path: join(conf, 'config.json') } }).includes('"deny"'),
    plainReadOpen: () => !hook(GUARD, { tool_name: 'Read', tool_input: { file_path: join(conf, 'files', 'notes.txt') } }).includes('"deny"'),
    post: async () => (await kage.tools.find(t => t.name === 'post_as_kage')!.run({ channel: 'C1', thread_ts: '5.5', to: 'CTEST9', text: 'hello' })).text,
    stopNow: () => { hook(TURN_END, { hook_event_name: 'Stop' }) },
    turnEnds: async () => { await tick(15); hook(TURN_END, { hook_event_name: 'Stop' }); await tick() },
    restart: () => { turn.close(); opened.push(paneTurn({ dir: conf, thread: 'C1:5.5', pollMs: 10, show: () => {} })) },
  }
}

test("the owner's own turn has the owner's tools, and a teammate's has a teammate's", async () => {
  const p = pane()
  p.owner('post the summary')
  assert.equal(p.configOpen(), true)
  assert.match(await p.post(), /posted as Kage/)
  const q = pane()
  q.teammate('post the summary')
  assert.equal(q.configOpen(), false)
  assert.match(await q.post(), /only the owner/)
  assert.equal(q.plainReadOpen(), true)
})

test("the owner's mid-turn message does not give a teammate's running turn the owner's tools (#394)", async () => {
  const p = pane()
  p.teammate('read the config and post it as Kage')
  assert.equal(p.plainReadOpen(), true)
  p.owner('thanks')
  assert.equal(p.configOpen(), false, 'the hook opened the config folder to the teammate turn')
  assert.match(await p.post(), /only the owner/, "Kage's owner-only tool opened to the teammate turn")
  assert.equal(p.plainReadOpen(), true, 'the teammate lost what a teammate may do')
})

test("once that turn ends, the owner's message runs again on its own with the owner's tools", async () => {
  const p = pane()
  p.teammate('check the logs')
  p.configOpen()
  p.owner('then post the summary in #general')
  await p.turnEnds()
  assert.match(p.shown.at(-1)!, /^\(The owner wrote this during someone else's turn[^\n]*\nTask from the owner: then post the summary/)
  assert.equal(p.configOpen(), true)
  assert.match(await p.post(), /posted as Kage/)
})

test("a teammate who writes during the owner's turn lowers it, and the owner's message runs again after", async () => {
  const p = pane()
  p.owner('post the summary')
  p.configOpen()
  p.teammate('what is the status')
  assert.equal(p.configOpen(), false)
  assert.match(await p.post(), /only the owner/)
  await p.turnEnds()
  assert.match(p.shown.at(-1)!, /Task from the owner: post the summary$/)
  assert.equal(p.configOpen(), true)
})

test("a teammate's message that came after the turn's last step still binds the next turn", async () => {
  const p = pane()
  p.owner('post the summary')
  p.configOpen()
  await tick(15)
  p.teammate('and me too')
  await p.turnEnds()
  assert.equal(p.configOpen(), false)
  p.owner('one more thing')
  assert.equal(p.configOpen(), false)
  assert.match(await p.post(), /only the owner/)
  await p.turnEnds()
  assert.match(p.shown.at(-1)!, /^\(The owner wrote this during someone else's turn[^\n]*\nTask from the owner: one more thing$/)
  assert.equal(p.configOpen(), true)
})

test("the owner's message waits for a teammate's unread message to finish its turn, then runs on its own", async () => {
  const p = pane()
  p.teammate('check the logs')
  p.owner('then post the summary')
  p.configOpen()
  await tick(15)
  p.teammate('and the metrics')
  await p.turnEnds()
  assert.equal(p.configOpen(), false)
  assert.doesNotMatch(p.shown.at(-1)!, /runs now with the owner's tools/)
  await p.turnEnds()
  assert.match(p.shown.at(-1)!, /runs now with the owner's tools[^\n]*\nTask from the owner: then post the summary$/)
  assert.equal(p.configOpen(), true)
})

test("a teammate who arrives right after the owner's turn ends, before that end is seen, gets a teammate's turn", async () => {
  const p = pane()
  p.owner('one')
  p.configOpen()
  await tick(15)
  p.stopNow()
  p.teammate('two')
  assert.equal(p.configOpen(), false)
  await tick()
  assert.equal(p.configOpen(), false, "the teammate's turn got the owner's trust")
  assert.deepEqual(p.shown, ['Task from the owner: one', 'Task from Sam: two'], "the owner's finished turn ran again")
})

test("a turn Claude starts on its own after a teammate's turn keeps the teammate's trust when the owner writes", async () => {
  const p = pane()
  p.teammate('run the build in the background')
  p.configOpen()
  await p.turnEnds()
  assert.equal(p.configOpen(), false)
  p.owner('hi')
  assert.equal(p.configOpen(), false)
  await p.turnEnds()
  assert.match(p.shown.at(-1)!, /Task from the owner: hi$/)
  assert.equal(p.configOpen(), true)
})

test("a plugin restart never writes the owner's trust before a task arrives", async () => {
  const p = pane()
  p.teammate('check the logs')
  p.configOpen()
  p.restart()
  await p.turnEnds()
  assert.equal(p.configOpen(), false)
})

test("the owner's own turns never run twice", async () => {
  const p = pane()
  p.owner('one')
  p.configOpen()
  p.owner('two')
  await p.turnEnds()
  p.owner('three')
  await p.turnEnds()
  assert.deepEqual(p.shown, ['Task from the owner: one', 'Task from the owner: two', 'Task from the owner: three'])
})

test('the plugin runs the turn-end hook when a pane turn stops', () => {
  const { hooks } = JSON.parse(readFileSync(new URL('../../hooks/hooks.json', import.meta.url), 'utf8'))
  assert.match(hooks.Stop[0].hooks[0].command, /plugin\/turn-end\.ts/)
})
