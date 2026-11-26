import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseSessionKey } from '../../core/conversations.ts'
import { dueSchedules } from '../../core/cron.ts'
import { hookTokenHash } from '../../core/tripwire.ts'
import { add, tune } from '../../runtime/schedule-edits.ts'
import { openStore } from '../../runtime/store.ts'
import { ownerJobs } from '../owner-jobs.ts'

const THREAD = 'C0TEST1:5.5'
function hub() {
  const store = openStore(join(mkdtempSync(join(tmpdir(), 'kage-jobs-')), 'kage.db'))
  store.seen(THREAD, parseSessionKey(THREAD)!.conversation, '#general', 0)
  const host = { store, trusted: () => true, job: { laneDefault: () => true } }
  const jobs = {
    add: (key: string, j: Parameters<typeof add>[2], now: number) => add(host, key, j, now),
    remove: (key: string, id: string) => { store.removeSchedule(id, key) },
    restore: (s: Parameters<typeof store.addSchedule>[0]) => store.addSchedule(s),
    hookUrl: (id: string) => `http://127.0.0.1:1/hook/${id}`,
  }
  return { store, ask: ownerJobs({ store, jobs, tune: (key, id, t, now) => tune(host, key, id, t, now), dir: '/kage' }) }
}
const idIn = (text: string) => /schedule ([0-9a-f]{8})/.exec(text)![1]!

test('add makes a clock job, a one-shot, a probe, a channel watch and a webhook in the thread, as the owner', () => {
  const h = hub()
  const clock = h.ask({ type: 'job', action: 'add', key: THREAD, spec: { cron: '0 9 * * 1-5', prompt: 'post the standup' } })
  assert.ok('text' in clock, JSON.stringify(clock))
  const once = h.ask({ type: 'job', action: 'add', key: THREAD, spec: { cron: '30 17 * * *', prompt: 'remind me', recurring: false } })
  const probe = h.ask({ type: 'job', action: 'add', key: THREAD, spec: { cron: '*/5 * * * *', prompt: 'say what changed', probe: { command: 'gh pr list', ignore: ['^#'] } } })
  const chan = h.ask({ type: 'job', action: 'add', key: THREAD, spec: { on_channel: { channel: 'C0TEST2', match: 'deploy', bots: false }, prompt: 'check the deploy' } })
  const hook = h.ask({ type: 'job', action: 'add', key: THREAD, spec: { hook: true, prompt: 'triage the alert' } })
  const byId = new Map(h.store.schedules().map(s => [s.id, s]))
  const s = (r: object) => byId.get(idIn((r as { text: string }).text))!
  assert.deepEqual([s(clock).cron, s(clock).recurring, s(clock).fromOwner, s(clock).lane], ['0 9 * * 1-5', true, true, true])
  assert.equal(s(once).recurring, false)
  assert.equal(s(probe).trigger?.kind, 'probe')
  assert.deepEqual(s(chan).trigger, { kind: 'channel', channel: 'C0TEST2', bots: false, match: 'deploy' })
  const token = /Token: ([0-9a-f]{48})/.exec((hook as { text: string }).text)![1]!
  assert.deepEqual(s(hook).trigger, { kind: 'hook', tokenHash: hookTokenHash(token) })
  assert.ok(!JSON.stringify(h.store.schedules()).includes(token))
})

test('add refuses a bad cron, a temp path, two triggers, an unknown thread and a field of the wrong type', () => {
  const h = hub()
  const no = (m: object) => { const r = h.ask({ type: 'job', ...m }); assert.ok('refused' in r, JSON.stringify(r)); return (r as { refused: string }).refused }
  assert.match(no({ action: 'add', key: THREAD, spec: { cron: '61 * * * *', prompt: 'x' } }), /minute/i)
  assert.match(no({ action: 'add', key: THREAD, spec: { cron: '0 9 * * *', prompt: 'read /tmp/x.csv' } }), /temp folder.*\/kage\/files\/C0TEST1_5\.5/)
  assert.match(no({ action: 'add', key: THREAD, spec: { cron: '0 9 * * *', hook: true, prompt: 'x' } }), /one trigger/)
  assert.match(no({ action: 'add', key: 'C0NONE:1.1', spec: { cron: '0 9 * * *', prompt: 'x' } }), /Slack threads only/)
  assert.match(no({ action: 'add', key: THREAD, spec: { cron: 5, prompt: 'x' } }), /cron/)
  assert.match(no({ action: 'nuke', id: 'x' }), /action/)
  assert.deepEqual(h.store.schedules(), [])
})

test('pause sets a job aside with its state, resume brings it back, rm removes it either way, and tune changes it', () => {
  const h = hub()
  const id = idIn((h.ask({ type: 'job', action: 'add', key: THREAD, spec: { cron: '*/5 * * * *', prompt: 'say what changed', probe: { command: 'gh pr list' } } }) as { text: string }).text)
  h.store.setJobState(id, { fails: 2, fp: 'abc' })
  const before = h.store.schedules()[0]!
  assert.match((h.ask({ type: 'job', action: 'pause', id }) as { text: string }).text, /Paused/)
  assert.deepEqual(h.store.schedules(), [])
  assert.match((h.ask({ type: 'job', action: 'pause', id }) as { refused: string }).refused, /no job/)
  const resumedAt = Date.now()
  assert.match((h.ask({ type: 'job', action: 'resume', id }) as { text: string }).text, /Resumed/)
  const back = h.store.schedules()[0]!
  assert.deepEqual({ ...back, lastFired: 0 }, { ...before, lastFired: 0 })
  assert.ok(back.lastFired >= resumedAt)
  assert.deepEqual(h.store.jobState(id), { fails: 2, fp: 'abc' })
  assert.ok('text' in h.ask({ type: 'job', action: 'tune', id, change: { cron: '*/10 * * * *' } }))
  assert.equal(h.store.schedules()[0]!.cron, '*/10 * * * *')
  h.ask({ type: 'job', action: 'pause', id })
  assert.ok('text' in h.ask({ type: 'job', action: 'rm', id }))
  assert.match((h.ask({ type: 'job', action: 'resume', id }) as { refused: string }).refused, /no paused job/)
  assert.deepEqual(h.store.schedules(), [])
})

test('resume counts a job from the resume time: a recurring job skips what came due while paused, and a one-shot whose time passed is removed', () => {
  const h = hub()
  const hoursAgo = Date.now() - 2 * 3_600_000
  const backdate = (id: string) => { const s = h.store.schedules().find(x => x.id === id)!; h.store.removeSchedule(id); h.store.addSchedule({ ...s, created: hoursAgo, lastFired: 0 }) }
  const every = idIn((h.ask({ type: 'job', action: 'add', key: THREAD, spec: { cron: '* * * * *', prompt: 'check' } }) as { text: string }).text)
  const once = idIn((h.ask({ type: 'job', action: 'add', key: THREAD, spec: { cron: '* * * * *', prompt: 'remind me', recurring: false } }) as { text: string }).text)
  backdate(every); backdate(once)
  h.ask({ type: 'job', action: 'pause', id: every }); h.ask({ type: 'job', action: 'pause', id: once })
  assert.match((h.ask({ type: 'job', action: 'resume', id: every }) as { text: string }).text, /Resumed/)
  assert.deepEqual(dueSchedules(h.store.schedules(), Date.now()).fire, [])
  assert.match((h.ask({ type: 'job', action: 'resume', id: once }) as { text: string }).text, new RegExp(`${once}.*time passed while it was paused`))
  assert.deepEqual(h.store.schedules().map(s => s.id), [every])
  assert.match((h.ask({ type: 'job', action: 'resume', id: once }) as { refused: string }).refused, /no paused job/)
})

test('pause refuses a job a twin shadows, so the twin is never left shadowing a job that looks gone', () => {
  const h = hub()
  const live = idIn((h.ask({ type: 'job', action: 'add', key: THREAD, spec: { cron: '0 9 * * *', prompt: 'post the standup' } }) as { text: string }).text)
  h.store.addSchedule({ ...h.store.schedules()[0]!, id: 'twin0001' })
  h.store.setJobState('twin0001', { fails: 0, shadow: { of: live, live: 'post', since: 0 } })
  assert.match((h.ask({ type: 'job', action: 'pause', id: live }) as { refused: string }).refused, /twin twin0001 shadows it/)
  assert.deepEqual(h.store.schedules().map(s => s.id).sort(), [live, 'twin0001'].sort())
})
