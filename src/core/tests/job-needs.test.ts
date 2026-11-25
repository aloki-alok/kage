import { test } from 'node:test'
import assert from 'node:assert/strict'
import { liveTools, needsChanges, twinLacks } from '../job-needs.ts'
import { EVENT, type Schedule } from '../cron.ts'

const server = (name: string, status: string, tools: string[] = []) => ({ name, status, tools: tools.map(t => ({ name: t })) })
const DIAL = 'mcp__claude_ai_Dialer__place_call'

test('the live tools are each connected server tool, named as a session sees it', () => {
  const { tools } = liveTools([server('claude.ai Dialer', 'connected', ['place_call']), server('claude.ai Gmail', 'needs-auth'), server('claude.ai  Slack (beta)', 'connected', ['post.message']), server('my crm', 'connected', ['read deals'])])
  assert.deepEqual([...tools], [DIAL, 'mcp__claude_ai_Slack_beta__post_message', 'mcp__my_crm__read_deals'])
})

test("a tool on a server still connecting keeps its last state; other servers' tools still count", () => {
  const live = liveTools([server('claude.ai Dialer', 'pending'), server('claude.ai Gmail', 'connected', ['search'])])
  assert.deepEqual(needsChanges([job()], live), [])
  assert.deepEqual(needsChanges([job([DIAL])], live), [])
  const [c] = needsChanges([{ ...job(), needs: [DIAL, 'mcp__claude_ai_Gmail__send'] }], live)
  assert.deepEqual(c!.missing, ['mcp__claude_ai_Gmail__send'])
})

const live = (tools: string[]) => ({ tools: new Set(tools), pending: [] })
const job = (missing?: string[]) => ({ id: 'a1b2', place: '#alerts', needs: [DIAL], ...missing && { missing } })

test('a job whose tools are all present changes nothing', () => {
  assert.deepEqual(needsChanges([job()], live([DIAL])), [])
})

test('the first miss tells the owner once, with the job and the missing tool', () => {
  const [c] = needsChanges([job()], live([]))
  assert.deepEqual(c!.missing, [DIAL])
  assert.match(c!.dm!, /a1b2 in #alerts/)
  assert.match(c!.dm!, /mcp__claude_ai_Dialer__place_call/)
  assert.doesNotMatch(c!.dm!, /runs no turn/, "an owner run's miss may be a passing connector failure, so it keeps running")
  assert.deepEqual(needsChanges([job([DIAL])], live([])), [], 'a second look while still missing says nothing')
})

test("a teammate-trust job with none of its tools is told it runs no turn; one that keeps a tool is not", () => {
  const [c] = needsChanges([{ ...job(), runs: 'teammate' }], live([DIAL]))
  assert.match(c!.dm!, /runs no turn/)
  const [d] = needsChanges([{ ...job(), runs: 'teammate', needs: [DIAL, 'mcp__kage__reply'] }], live([]))
  assert.match(d!.dm!, /runs no turn/, 'its own tools do not count as a need it still has')
  const [e] = needsChanges([{ ...job(), needs: [DIAL, 'mcp__claude_ai_Slack__read'] }], live(['mcp__claude_ai_Slack__read']))
  assert.doesNotMatch(e!.dm!, /runs no turn/)
})

test('the tool coming back tells the owner once more', () => {
  const [c] = needsChanges([job([DIAL])], live([DIAL]))
  assert.deepEqual(c!.missing, [])
  assert.match(c!.dm!, /a1b2 .*again/)
})

test('a job with no needs is never checked', () => {
  assert.deepEqual(needsChanges([{ id: 'x', place: '#a', needs: [] }], live([])), [])
})

test("a job saved missing only Kage's own tools is cleared with no DM; a real tool still counts", () => {
  const own = 'mcp__kage__browser_click'
  assert.deepEqual(needsChanges([{ ...job([own]), needs: [DIAL, own] }], live([DIAL])), [{ id: 'a1b2', missing: [] }])
  const [c] = needsChanges([{ ...job([own]), needs: [DIAL, own] }], live([]))
  assert.deepEqual(c!.missing, [DIAL])
  assert.match(c!.dm!, /needs mcp__claude_ai_Dialer__place_call, and/)
})

test("Kage's own tools on the tmux route are never watched either", () => {
  assert.deepEqual(needsChanges([{ ...job(), needs: [DIAL, 'mcp__plugin_kage_kage__reply'] }], live([DIAL])), [])
})

test("a job whose runs get a teammate's trust misses every owner tool, even when the owner's sessions have it", () => {
  const slackRead = 'mcp__kage__slack_read', reply = 'mcp__kage__reply'
  const [c] = needsChanges([{ ...job(), runs: 'teammate' as const, needs: [DIAL, slackRead, reply] }], live([DIAL]))
  assert.deepEqual(c!.missing, [DIAL, slackRead])
  assert.match(c!.dm!, /a1b2 in #alerts/)
  assert.match(c!.dm!, /teammate's trust/)
  assert.match(c!.dm!, /set the job up again from your own DM/)
  assert.deepEqual(needsChanges([{ ...job([DIAL, slackRead]), runs: 'teammate' as const, needs: [DIAL, slackRead, reply] }], live([DIAL])), [], 'a second look says nothing')
})

test("a wake's DM says to make it a clock job, because setting it up again keeps the teammate's trust", () => {
  const [c] = needsChanges([{ ...job(), runs: 'wake' }], live([DIAL]))
  assert.deepEqual(c!.missing, [DIAL])
  assert.match(c!.dm!, /teammate's trust/)
  assert.match(c!.dm!, /clock job/)
  assert.doesNotMatch(c!.dm!, /set the job up again/)
})

test("a teammate's job is still missing an owner tool while that server connects", () => {
  const [c] = needsChanges([{ ...job(), runs: 'teammate' }], { tools: new Set(), pending: ['mcp__claude_ai_Dialer__'] })
  assert.deepEqual(c!.missing, [DIAL])
})

test("a twin woken by events lacks each of the old job's tools a teammate's trust never loads; a clock twin or a Kage-only need lacks none (#641)", () => {
  const job = (o: Partial<Schedule>): Schedule => ({ id: 'j', key: 'C1:5.5', cron: '*/10 * * * *', prompt: 'p', recurring: true, fromOwner: true, created: 0, lastFired: 0, ...o })
  const old = job({ needs: ['mcp__pager__call', 'mcp__kage__reply'] })
  const owner = { ownerThread: true, probesOn: true }
  assert.deepEqual(twinLacks(old, job({ cron: EVENT, trigger: { kind: 'channel', channel: 'C9', bots: false } }), owner), ['mcp__pager__call'])
  assert.deepEqual(twinLacks(old, job({ trigger: { kind: 'probe', probe: { command: 'x' } } as Schedule['trigger'] }), owner), ['mcp__pager__call'])
  assert.deepEqual(twinLacks(old, job({ trigger: { kind: 'probe', probe: { command: 'x' } } as Schedule['trigger'] }), { ...owner, probesOn: false }), [])
  assert.deepEqual(twinLacks(old, job({}), owner), [])
  assert.deepEqual(twinLacks(job({ needs: ['mcp__kage__reply'] }), job({ cron: EVENT }), owner), [])
  assert.deepEqual(twinLacks(old, job({ cron: EVENT }), { ...owner, ownerThread: false }), [])
})
