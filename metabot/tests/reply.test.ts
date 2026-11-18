import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { handle, type Deps, type SinkLead } from '../reply.ts'
import { openStore } from '../store.ts'
import type { GraphRequest } from '../graph.ts'
import type { MetaEvent } from '../meta.ts'

const NOW = Date.parse('2026-11-18T12:00:00Z')
const pack = { facts: 'Plans start at $10 a month.', links: ['https://www.omnidim.io/pricing'] }
const answer = (o: Record<string, unknown> = {}) => JSON.stringify({ reply: 'Plans start at $10: https://www.omnidim.io/pricing', label: 'self_serve', lead: {}, ...o })
let n = 0
const msg = (text = 'price?', user = 'U1'): MetaEvent => ({ kind: 'message', channel: 'messenger', pageId: 'P1', user, id: `m${++n}`, text, at: NOW })

function rig(o: { mode?: 'dry' | 'team' | 'live' | 'off'; model?: string; guard?: string; team?: string[] } = {}) {
  const sent: GraphRequest[] = [], sunk: SinkLead[] = [], missed: string[] = []
  const store = openStore(':memory:')
  const d: Deps = {
    store, now: () => NOW,
    settings: { brand: 'OmniDimension', mode: o.mode ?? 'live', ourAppId: 'APP', team: o.team ?? [], limits: { repliesPerLeadPerDay: 2, humanQuietHours: 72 }, maxChars: 600, historyLines: 20, publicCommentLine: '', fallbackReply: '' },
    read: () => ({ job: 'Be kind.', pack }),
    model: async (_m, json) => (json ? o.model ?? answer() : o.guard ?? 'SEND'),
    send: async r => { sent.push(r) },
    sink: async l => { sunk.push(l) },
    missed: q => missed.push(q),
  }
  return { d, store, sent, sunk, missed }
}

describe('one lead message, start to finish', () => {
  test('live: a good answer is sent and counted, and a redelivery runs once', async () => {
    const { d, sent } = rig()
    const ev = msg()
    assert.equal(await handle(ev, d), 'sent')
    assert.equal(await handle(ev, d), 'repeat')
    assert.equal(sent.length, 1)
  })

  test('dry and team never send to a lead; team sends to a tester', async () => {
    const dry = rig({ mode: 'dry' })
    assert.equal(await handle(msg(), dry.d), 'drafted')
    assert.equal(dry.sent.length, 0)
    assert.equal(dry.store.drafts(5).length, 1)
    const team = rig({ mode: 'team', team: ['T1'] })
    assert.equal(await handle(msg('hi', 'U9'), team.d), 'drafted')
    assert.equal(await handle(msg('hi', 'T1'), team.d), 'sent')
    assert.equal(team.sent.length, 1)
  })

  test('a bad answer or a guard HOLD never leaves', async () => {
    const bad = rig({ model: answer({ reply: 'Pay at https://evil.example' }) })
    assert.equal(await handle(msg(), bad.d), 'held_check')
    const held = rig({ guard: 'HOLD: wrong price' })
    assert.equal(await handle(msg(), held.d), 'held_guard')
    assert.equal(bad.sent.length + held.sent.length, 0)
  })

  test('with a fallback line set, a held reply sends that line instead, under the same mode gate', async () => {
    const live = rig({ guard: 'HOLD: wrong price' })
    live.d.settings.fallbackReply = 'Thanks! Plans: https://www.omnidim.io/pricing'
    assert.equal(await handle(msg(), live.d), 'held_guard_fallback')
    assert.deepEqual(live.sent.map(r => (r.body.message as { text: string }).text), ['Thanks! Plans: https://www.omnidim.io/pricing'])
    const dry = rig({ mode: 'dry', model: 'not json' })
    dry.d.settings.fallbackReply = 'Thanks!'
    assert.equal(await handle(msg(), dry.d), 'held_check')
    assert.equal(dry.sent.length, 0)
  })

  test('after a person answers in the inbox, the bot stays out of that thread', async () => {
    const { d, sent } = rig()
    assert.equal(await handle({ kind: 'echo', channel: 'messenger', pageId: 'P1', user: 'U1', id: 'e1', appId: 'INBOX', at: NOW }, d), 'human')
    assert.equal(await handle(msg(), d), 'human_took_over')
    assert.equal(sent.length, 0)
  })

  test('the daily cap stops the bot', async () => {
    const { d } = rig()
    assert.equal(await handle(msg(), d), 'sent')
    assert.equal(await handle(msg(), d), 'sent')
    assert.equal(await handle(msg(), d), 'over_limit')
  })

  test('a lead with a contact and a real need goes to the sink; a vague one does not', async () => {
    const { d, sunk } = rig({ model: answer({ label: 'qualified', lead: { phone: '+91 90000 00000', need: 'collections' } }) })
    await handle(msg(), d)
    assert.equal(sunk.length, 1)
    assert.equal(sunk[0]!.label, 'qualified')
    const vague = rig({ model: answer({ label: 'needs_info', lead: { phone: '+91 90000 00000' } }) })
    await handle(msg(), vague.d)
    assert.equal(vague.sunk.length, 0)
  })

  test('a question the knowledge could not answer goes to the teacher', async () => {
    const { d, missed } = rig({ model: answer({ label: 'hand_off', missed: 'Do you support Tamil?' }) })
    await handle(msg(), d)
    assert.deepEqual(missed, ['Do you support Tamil?'])
  })

  test('the model sees the earlier lines of the thread', async () => {
    const seen: number[] = []
    const { d } = rig()
    d.model = async (m, json) => { if (json) seen.push(m.length); return json ? answer() : 'SEND' }
    await handle(msg('first'), d)
    await handle(msg('second'), d)
    assert.deepEqual(seen, [2, 4])
  })
})
