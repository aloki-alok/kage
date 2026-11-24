import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mcpStatus, needsWatch } from '../job-needs.ts'
import { openStore } from '../store.ts'
import { jobRunner } from '../jobs.ts'

const DIAL = 'mcp__claude_ai_Dialer__place_call'
const dialer = (status: string) => [{ name: 'claude.ai Dialer', status, tools: status === 'connected' ? [{ name: 'place_call' }] : [] }]

function setup(o: { notifyFails?: boolean; probesOn?: boolean } = {}) {
  let fails = !!o.notifyFails, broken = false
  const store = openStore(':memory:')
  store.setTrust('C1:5.5', true)
  store.addSchedule({ id: 'a1b2', key: 'C1:5.5', cron: '*/10 * * * *', prompt: 'phone on-call', recurring: true, fromOwner: true, created: 0, lastFired: 0, needs: [DIAL] })
  store.addSchedule({ id: 'c3d4', key: 'C1:5.5', cron: '0 9 * * *', prompt: 'summary', recurring: true, fromOwner: true, created: 0, lastFired: 0 })
  const dms: string[] = []
  let seen = dialer('connected')
  const looks: number[] = []
  const w = needsWatch({ store, placeOf: () => { if (broken) throw new Error('db busy'); return '#alerts' }, notify: async t => { if (fails) return false; dms.push(t); return true }, look: async () => { looks.push(1); return seen }, minutes: 1, probesOn: () => o.probesOn ?? true })
  const runner = jobRunner(w.jobs, 0)
  const tick = async (now: number) => { runner.tick(now); await new Promise(r => setTimeout(r, 5)) }
  return { store, dms, looks, w, tick, set: (s: string) => { seen = dialer(s) }, fails: (f: boolean) => { fails = f }, breakPlace: (b: boolean) => { broken = b } }
}

test('present, missing, then back: one DM on the miss, one when it is back, and kage schedule list sees the miss', async () => {
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
  t.fails(false)
  await t.tick(120_000)
  assert.equal(t.dms.length, 1)
  assert.deepEqual(t.store.jobState('a1b2').missing, [DIAL])
})

test('one failed check does not stop the later ones', async () => {
  const t = setup()
  t.set('failed')
  t.breakPlace(true)
  await t.tick(60_000)
  t.breakPlace(false)
  await t.tick(120_000)
  assert.equal(t.dms.length, 1)
})

test('a status that never comes in gives up, so the clock is not stuck', async () => {
  const q = { initializationResult: () => new Promise(() => {}), mcpServerStatus: async () => [] }
  await assert.rejects(mcpStatus(q, 1, 1, 10), /did not come in time/)
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

test("Kage's own tools never read as missing: the clock's probe has no kage server, real sessions do", async () => {
  const t = setup()
  t.store.setNeeds('a1b2', [DIAL, 'mcp__kage__reply'])
  await t.tick(60_000)
  await t.w.seen([...dialer('connected'), { name: 'kage', status: 'connected', tools: [{ name: 'reply' }] }])
  await t.tick(120_000)
  assert.deepEqual(t.dms, [])
  assert.equal(t.store.jobState('a1b2').missing, undefined)
})

test("a teammate's job is told missing the owner's tools on the first look, though the owner's sessions have them", async () => {
  const t = setup()
  t.store.addSchedule({ id: 'e5f6', key: 'C2:6.6', cron: '*/10 * * * *', prompt: 'phone on-call', recurring: true, fromOwner: false, created: 0, lastFired: 0, needs: [DIAL] })
  await t.tick(60_000)
  assert.equal(t.dms.length, 1)
  assert.match(t.dms[0]!, /e5f6 in #alerts needs mcp__claude_ai_Dialer__place_call/)
  assert.deepEqual(t.store.jobState('e5f6').missing, [DIAL])
  assert.equal(t.store.jobState('a1b2').missing, undefined, "the owner's job still has its tool")
})

test("the owner's event job is told missing too, because a wake runs with a teammate's trust", async () => {
  const t = setup()
  t.store.addSchedule({ id: 'g7h8', key: 'C1:5.5', cron: '@event', prompt: 'phone on-call', recurring: true, fromOwner: true, created: 0, lastFired: 0, trigger: { kind: 'hook', tokenHash: 'x' }, needs: [DIAL] })
  await t.tick(60_000)
  assert.equal(t.dms.length, 1)
  assert.match(t.dms[0]!, /g7h8 in #alerts .*teammate's trust/)
  assert.equal(t.store.jobState('a1b2').missing, undefined)
})

test("with tripwires off, the owner's probe job runs on its clock as the owner, so its tool counts as present", async () => {
  const add = (t: ReturnType<typeof setup>) => t.store.addSchedule({ id: 'p9q0', key: 'C1:5.5', cron: '*/5 * * * *', prompt: 'check', recurring: true, fromOwner: true, created: 0, lastFired: 0, trigger: { kind: 'probe', probe: { command: 'true', ignore: [], reads: [], writes: [], pins: {} } as never }, needs: [DIAL] })
  const off = setup({ probesOn: false })
  add(off)
  await off.tick(60_000)
  assert.deepEqual(off.dms, [])
  const on = setup()
  add(on)
  await on.tick(60_000)
  assert.match(on.dms[0]!, /p9q0 .*teammate's trust/)
})
