import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tsvRow } from '../../core/ledgers.ts'
import type { Schedule } from '../../core/cron.ts'
import { shadowSwaps } from '../shadow-swap.ts'
import { openStore } from '../store.ts'

const M = 60_000
const T0 = Date.parse('2026-11-16T00:00:00Z')
const iso = (t: number) => new Date(t).toISOString()
const job = (id: string, prompt: string): Schedule => ({ id, key: 'C1:5.5', cron: '*/15 * * * *', prompt, recurring: true, fromOwner: true, created: T0, lastFired: 0 })

function setup(cfg: { swapAfter?: number; shadowWindowMin?: number; swapUndoDays?: number } = {}) {
  const store = openStore(':memory:')
  store.addSchedule(job('old', 'the old prompt'))
  store.addSchedule(job('tw', 'SHADOW prompt'))
  store.setJobState('tw', { fails: 0, shadow: { of: 'old', live: 'the live prompt', since: T0 } })
  const rows: Record<string, string> = { posted: '', 'prod-actions': '', verdicts: '' }
  const pings: string[] = [], dms: string[] = [], events: string[] = [], removed: string[] = []
  const sw = shadowSwaps({
    store, settings: () => cfg,
    ledgers: { text: name => rows[name] ?? '' },
    ping: (_key, text) => { pings.push(text) },
    owner: text => { dms.push(text) },
    event: detail => { events.push(detail) },
    remove: id => { removed.push(id); store.removeSchedule(id) },
    restore: s => { store.addSchedule(s) },
  })
  const acted = (t: number) => { rows.posted += tsvRow([iso(t), 'C1', `${t}`, 'bot', 'C1:5.5', 'old']) }
  const said = (t: number, act = true) => { rows.verdicts += tsvRow([iso(t), 'tw', act ? 'act' : 'quiet', 'x']) }
  return { store, sw, rows, acted, said, pings, dms, events, removed }
}

test('three matches and no miss: the twin goes live first, then the old job goes, with one line in the thread', () => {
  const t = setup()
  for (const h of [1, 2, 3]) { t.acted(T0 + h * 60 * M); t.said(T0 + h * 60 * M + 2 * M) }
  t.sw.tick(T0 + 5 * 60 * M)
  const tw = t.store.schedules().find(s => s.id === 'tw')!
  assert.equal(tw.prompt, 'the live prompt')
  assert.equal(t.store.jobState('tw').shadow, undefined)
  assert.deepEqual(t.store.schedules().map(s => s.id), ['tw'])
  assert.equal(t.pings.length, 1)
  assert.match(t.pings[0]!, /undo the swap/)
  assert.ok(t.events.some(e => e === 'swap job=tw of=old matches=3'))
})

test('two matches wait; quiet runs on both sides add nothing', () => {
  const t = setup()
  for (const h of [1, 2]) { t.acted(T0 + h * 60 * M); t.said(T0 + h * 60 * M) }
  t.said(T0 + 4 * 60 * M, false)
  t.sw.tick(T0 + 6 * 60 * M)
  assert.deepEqual(t.store.schedules().map(s => s.id).sort(), ['old', 'tw'])
  assert.equal(t.pings.length, 0)
})

test('the 2026-11-16 case: the old job acted, the twin never woke. No swap, one DM to the owner, told once', () => {
  const t = setup()
  for (const h of [1, 2, 3]) { t.acted(T0 + h * 60 * M); t.said(T0 + h * 60 * M) }
  t.acted(T0 + 4 * 60 * M)
  t.sw.tick(T0 + 6 * 60 * M)
  t.sw.tick(T0 + 7 * 60 * M)
  assert.deepEqual(t.store.schedules().map(s => s.id).sort(), ['old', 'tw'])
  assert.equal(t.dms.length, 1)
  assert.match(t.dms[0]!, /tw missed/)
  assert.equal(t.events.filter(e => e.startsWith('shadow job=tw of=old result=miss kind=missed')).length, 1)
})

test('a prod write by the old job counts as an act', () => {
  const t = setup({ swapAfter: 1 })
  t.rows['prod-actions'] += tsvRow([iso(T0 + 60 * M), 'owner', 'link', 'rate set', 'cmd', 'ok', 'old'])
  t.sw.tick(T0 + 3 * 60 * M)
  assert.equal(t.dms.length, 1)
})

test('a crash after the twin went live and before the old job went: the next tick finishes the swap', () => {
  const t = setup()
  t.store.save('swapped-out', { old: { job: job('old', 'the old prompt'), state: { fails: 0 }, twin: 'tw', twinPrompt: 'SHADOW prompt', shadow: { of: 'old', live: 'the live prompt', since: T0 }, at: T0 } })
  t.store.setJobState('tw', { fails: 0 })
  t.sw.tick(T0 + M)
  assert.deepEqual(t.store.schedules().map(s => s.id), ['tw'])
})

test('restore: the owner gets the old job back, and the twin is a shadow again with its count restarted', () => {
  const t = setup()
  for (const h of [1, 2, 3]) { t.acted(T0 + h * 60 * M); t.said(T0 + h * 60 * M) }
  t.sw.tick(T0 + 5 * 60 * M)
  assert.equal(t.sw.restore('C1:5.5', 'old', T0 + 6 * 60 * M), undefined)
  assert.deepEqual(t.store.schedules().map(s => s.id).sort(), ['old', 'tw'])
  assert.equal(t.store.schedules().find(s => s.id === 'tw')!.prompt, 'SHADOW prompt')
  assert.deepEqual(t.store.jobState('tw').shadow, { of: 'old', live: 'the live prompt', since: T0 + 6 * 60 * M })
  assert.match(t.sw.restore('C1:5.5', 'old', T0 + 7 * 60 * M) ?? '', /no swapped-out job old/)
  assert.match(t.sw.restore('C9:1.1', 'nope', T0) ?? '', /no swapped-out job nope/)
})

test('restore refuses a job of another thread', () => {
  const t = setup()
  for (const h of [1, 2, 3]) { t.acted(T0 + h * 60 * M); t.said(T0 + h * 60 * M) }
  t.sw.tick(T0 + 5 * 60 * M)
  assert.match(t.sw.restore('C2:1.1', 'old', T0 + 6 * 60 * M) ?? '', /not in this thread/)
})

test('a saved old job is dropped after swapUndoDays', () => {
  const t = setup({ swapUndoDays: 7 })
  for (const h of [1, 2, 3]) { t.acted(T0 + h * 60 * M); t.said(T0 + h * 60 * M) }
  t.sw.tick(T0 + 5 * 60 * M)
  t.sw.tick(T0 + 8 * 24 * 60 * M)
  assert.match(t.sw.restore('C1:5.5', 'old', T0 + 8 * 24 * 60 * M) ?? '', /no swapped-out job old/)
})

test('the old job was removed by a person: the owner is told once, and the twin never swaps', () => {
  const t = setup()
  t.store.removeSchedule('old')
  t.sw.tick(T0 + M)
  t.sw.tick(T0 + 2 * M)
  assert.equal(t.dms.length, 1)
  assert.match(t.dms[0]!, /which is gone/)
  assert.equal(t.store.schedules().find(s => s.id === 'tw')!.prompt, 'SHADOW prompt')
})

test('each miss is told once, also when a later miss sorts before one already told', () => {
  const t = setup()
  t.said(T0 + 60 * M)
  t.sw.tick(T0 + 120 * M)
  t.acted(T0 + 30 * M - 1)
  t.sw.tick(T0 + 121 * M)
  t.sw.tick(T0 + 122 * M)
  assert.equal(t.dms.length, 2)
  assert.match(t.dms[0]!, /false alarm/)
  assert.match(t.dms[1]!, /tw missed an event/)
})

test('the ledgers are read from one shadow window before the twin started', () => {
  const t = setup({ shadowWindowMin: 45 })
  const asked: string[] = []
  const sw = shadowSwaps({ store: t.store, settings: () => ({ shadowWindowMin: 45 }), ledgers: { text: (name, since) => { asked.push(`${name} ${since}`); return '' } },
    ping: () => {}, owner: () => {}, event: () => {}, remove: () => {}, restore: () => {} })
  sw.tick(T0 + 60 * M)
  assert.deepEqual(asked, ['posted', 'prod-actions', 'verdicts'].map(n => `${n} ${iso(T0 - 45 * M)}`))
})

test('a quiet verdict is not an act: the twin that stays quiet while the old job acts misses, and never swaps in', () => {
  const t = setup()
  for (const h of [1, 2, 3]) { t.acted(T0 + h * 60 * M); t.said(T0 + h * 60 * M + 2 * M, false) }
  t.sw.tick(T0 + 5 * 60 * M)
  assert.ok(t.store.jobState('tw').shadow)
  assert.deepEqual(t.removed, [])
  assert.equal(t.dms.filter(d => / missed an event/.test(d)).length, 3)
})

test('undo brings the old job back with the state it had, such as its failure count', () => {
  const t = setup()
  t.store.setJobState('old', { fails: 2 })
  for (const h of [1, 2, 3]) { t.acted(T0 + h * 60 * M); t.said(T0 + h * 60 * M + 2 * M) }
  t.sw.tick(T0 + 5 * 60 * M)
  assert.deepEqual(t.removed, ['old'])
  assert.equal(t.sw.restore('C1:5.5', 'old', T0 + 6 * 60 * M), undefined)
  assert.equal(t.store.jobState('old').fails, 2)
})

test("a twin that can never load the owner's tools the old job needs is held, with one DM, and never swaps in (#641)", () => {
  const t = setup()
  t.store.removeSchedule('old'); t.store.removeSchedule('tw')
  t.store.addSchedule({ ...job('old', 'the old prompt'), needs: ['mcp__pager__call'] })
  t.store.addSchedule({ ...job('tw', 'SHADOW prompt'), cron: '@event', trigger: { kind: 'channel', channel: 'C9', bots: false } })
  t.store.setJobState('tw', { fails: 0, shadow: { of: 'old', live: 'the live prompt', since: T0 } })
  t.store.setTrust('C1:5.5', true)
  for (const h of [1, 2, 3]) { t.acted(T0 + h * 60 * M); t.said(T0 + h * 60 * M + 2 * M) }
  t.sw.tick(T0 + 5 * 60 * M)
  t.sw.tick(T0 + 6 * 60 * M)
  assert.deepEqual(t.store.schedules().map(s => s.id).sort(), ['old', 'tw'])
  assert.equal(t.dms.length, 1)
  assert.match(t.dms[0]!, /^Twin tw can never swap in for job old: old needs mcp__pager__call/)
  assert.deepEqual(t.removed, [])
})
