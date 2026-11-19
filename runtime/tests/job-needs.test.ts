import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mcpStatus, needsWatch } from '../job-needs.ts'
import { openStore } from '../store.ts'
import { jobRunner } from '../jobs.ts'

const DIAL = 'mcp__claude_ai_Dialer__place_call'
const dialer = (status: string) => [{ name: 'claude.ai Dialer', status, tools: status === 'connected' ? [{ name: 'place_call' }] : [] }]

function setup(o: { notifyFails?: boolean } = {}) {
  const store = openStore(':memory:')
  store.addSchedule({ id: 'a1b2', key: 'C1:5.5', cron: '@event', prompt: 'phone on-call', recurring: true, fromOwner: true, created: 0, lastFired: 0, needs: [DIAL] })
  store.addSchedule({ id: 'c3d4', key: 'C1:5.5', cron: '0 9 * * *', prompt: 'summary', recurring: true, fromOwner: true, created: 0, lastFired: 0 })
  const dms: string[] = []
  let seen = dialer('connected')
  const looks: number[] = []
  const w = needsWatch({ store, placeOf: () => '#alerts', notify: async t => { if (o.notifyFails) return false; dms.push(t); return true }, look: async () => { looks.push(1); return seen }, minutes: 1 })
  const runner = jobRunner(w.jobs, 0)
  const tick = async (now: number) => { runner.tick(now); await new Promise(r => setTimeout(r, 5)) }
  return { store, dms, looks, w, tick, set: (s: string) => { seen = dialer(s) } }
}

test('present, missing, then back: one DM on the miss, one when it is back, and kage schedules sees the miss', async () => {
  const t = setup()
  await t.tick(60_000)
  assert.deepEqual(t.dms, [])
  t.set('needs-auth')
  await t.tick(120_000)
  assert.equal(t.dms.length, 1)
  assert.match(t.dms[0]!, /a1b2 in #alerts needs mcp__claude_ai_Dialer__place_call/)
  assert.deepEqual(t.store.jobState('a1b2').missing, [DIAL])
  await t.tick(180_000)
  assert.equal(t.dms.length, 1, 'still missing says nothing more')
  t.set('connected')
  await t.tick(240_000)
  assert.equal(t.dms.length, 2)
  assert.match(t.dms[1]!, /a1b2 .* again/)
  assert.equal(t.store.jobState('a1b2').missing, undefined)
})

test('a server still connecting changes nothing', async () => {
  const t = setup()
  t.set('pending')
  await t.tick(60_000)
  assert.deepEqual(t.dms, [])
  assert.equal(t.store.jobState('a1b2').missing, undefined)
})

test('a DM that fails to send is tried again on the next look', async () => {
  const t = setup({ notifyFails: true })
  t.set('failed')
  await t.tick(60_000)
  assert.equal(t.store.jobState('a1b2').missing, undefined)
})

test('with no job that needs a tool, the clock never opens a probe session', async () => {
  const t = setup()
  t.store.removeSchedule('a1b2', 'C1:5.5')
  await t.tick(60_000)
  assert.deepEqual(t.looks, [])
})

test("a session's own MCP status counts once its servers settle", async () => {
  const t = setup()
  const states = ['pending', 'pending', 'needs-auth']
  const q = { initializationResult: async () => ({}), mcpServerStatus: async () => dialer(states.shift() ?? 'needs-auth') }
  await t.w.seen(await mcpStatus(q, 10))
  assert.equal(t.dms.length, 1)
})
