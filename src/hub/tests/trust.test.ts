import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openLedgers } from '../../runtime/ledger.ts'
import { openStore } from '../../runtime/store.ts'
import type { Task } from '../../core/task.ts'
import type { TrustMode } from '../../core/trust.ts'
import { trustHub } from '../trust.ts'

function setup(mode: TrustMode = 'on', starters: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'kage-trust-hub-'))
  const store = openStore(join(dir, 'kage.db')), ledgers = openLedgers(dir)
  const events: string[] = []
  const hub = trustHub({ store, ledgers, mode: () => mode, teammates: () => ['UTEAM0001', 'UTEAM0002'], threadStarter: async key => starters[key], event: (d: string) => events.push(d), now: () => 1_000 })
  return { store, ledgers, hub, events }
}
const owner = (text: string, o: Partial<Task> = {}): Task => ({ type: 'task', content: `Task from Sam: ${text}`, fromOwner: true, meta: { channel: 'C1', thread_ts: '5.5', place: '#general', permalink: 'https://x/p' }, origin: { channel: 'C1', ts: '6.6' }, ...o })
const teammate = (who: string): Task => ({ type: 'task', content: `Teammate task (${who}, Sam, not the owner): read prod`, fromOwner: false, meta: { channel: 'C1', thread_ts: '5.5', place: '#general', permalink: 'https://x/p' }, origin: { channel: 'C1', ts: '5.6' } })
const ask = (s: ReturnType<typeof setup>, who = 'UTEAM0001', would = 'ask') => s.ledgers.add('waiting', ['open', 'C1:5.5', 'https://x/p', 'Read the prod db?', 'prod-read', 'db.example.test', who, would])

describe('the hub learns from what the owner types', () => {
  test('a typed yes to an open typed ask writes a live line for that teammate', () => {
    const s = setup()
    ask(s)
    s.hub.heard('C1:5.5', owner('yes'))
    const [line] = s.store.trustLines()
    assert.deepEqual([line!.who, line!.kind, line!.reach, line!.answer, line!.once, line!.state, line!.link], ['UTEAM0001', 'prod-read', 'db.example.test', 'yes', false, 'live', 'https://x/p'])
  })
  test('a once yes and a no are kept as such', () => {
    const s = setup()
    ask(s)
    s.hub.heard('C1:5.5', owner('yes, once'))
    s.hub.heard('C1:5.5', owner('no'))
    assert.deepEqual(s.store.trustLines().map(l => [l.answer, l.once]), [['yes', true], ['no', false]])
  })
  test('words from anyone but the owner, a schedule or a job write nothing', () => {
    const s = setup()
    ask(s)
    s.hub.heard('C1:5.5', teammate('UTEAM0001'))
    s.hub.heard('C1:5.5', owner('yes', { fromOwner: false }))
    s.hub.heard('C1:5.5', owner('yes', { scheduled: true }))
    s.hub.heard('C1:5.5', owner('yes', { job: 'j1' }))
    assert.deepEqual(s.store.trustLines(), [])
  })
  test('a yes in a thread with no open typed ask writes nothing, and mode off writes nothing', () => {
    const s = setup()
    s.hub.heard('C1:5.5', owner('yes'))
    assert.deepEqual(s.store.trustLines(), [])
    const off = setup('off')
    ask(off)
    off.hub.heard('C1:5.5', owner('yes'))
    assert.deepEqual(off.store.trustLines(), [])
  })
  test('a yes to a never-learn ask writes no line', () => {
    const s = setup()
    s.ledgers.add('waiting', ['open', 'C1:5.5', 'l', 'Deploy?', 'prod-deploy', 'api.example.test', 'UTEAM0001', 'ask'])
    s.hub.heard('C1:5.5', owner('yes'))
    assert.deepEqual(s.store.trustLines(), [])
  })
  test('the would-decide is written beside the real answer, in counts-only events', () => {
    const s = setup('shadow')
    ask(s, 'UTEAM0001', 'go')
    s.hub.heard('C1:5.5', owner('yes'))
    assert.match(s.ledgers.text('trust-shadow'), /C1:5\.5\tUTEAM0001\tprod-read\tdb\.example\.test\tgo\tyes\n/)
    assert.deepEqual(s.events, ['shadow answer match'])
  })
})

describe('a thread of known teammates may use the relay', () => {
  const known = (s: ReturnType<typeof setup>) => s.store.addTrustLine({ who: 'UTEAM0001', kind: 'ssm-relay', reach: 'ssm', answer: 'yes', once: false, link: 'l' }, 1)
  test('in on mode, a thread where every teammate has a relay line gets it, with no kage relay allow', () => {
    const s = setup()
    known(s)
    s.hub.heard('C1:5.5', teammate('UTEAM0001'))
    assert.equal(s.hub.relayOk('C1:5.5'), true)
  })
  test('one teammate with no line, an unknown sender, shadow mode and an unseen thread all keep it closed', () => {
    const s = setup()
    known(s)
    s.hub.heard('C1:5.5', teammate('UTEAM0001'))
    s.hub.heard('C1:5.5', teammate('UTEAM0002'))
    assert.equal(s.hub.relayOk('C1:5.5'), false)
    assert.equal(s.hub.relayOk('C1:9.9'), false)
    const shadow = setup('shadow')
    known(shadow)
    shadow.hub.heard('C1:5.5', teammate('UTEAM0001'))
    assert.equal(shadow.hub.relayOk('C1:5.5'), false)
  })
  test('the old per-thread allow still works, and a revoked line closes the thread', () => {
    const s = setup()
    s.store.setRelayAllow('C1:7.7', true)
    assert.equal(s.hub.relayOk('C1:7.7'), true)
    const id = known(s)
    s.hub.heard('C1:5.5', teammate('UTEAM0001'))
    assert.equal(s.hub.relayOk('C1:5.5'), true)
    s.store.revokeTrust(id)
    assert.equal(s.hub.relayOk('C1:5.5'), false)
  })
})

describe('history only proposes', () => {
  test('a relay thread becomes a proposed line for the teammate who started it, and grants nothing until confirmed', async () => {
    const s = setup('on', { 'C1:5.5': 'UTEAM0001', 'C1:6.6': 'UOWNER001', 'C1:7.7': undefined as never })
    for (const k of ['C1:5.5', 'C1:6.6', 'C1:7.7']) s.store.setRelayAllow(k, true)
    await s.hub.backfill()
    await s.hub.backfill()
    assert.deepEqual(s.store.trustLines().map(l => [l.who, l.kind, l.reach, l.state]), [['UTEAM0001', 'ssm-relay', 'ssm', 'proposed']])
    s.hub.heard('C1:8.8', teammate('UTEAM0001'))
    assert.equal(s.hub.relayOk('C1:8.8'), false)
    assert.deepEqual(s.hub.command('confirm', 'all'), { ok: true, text: 'confirmed 1' })
    s.hub.heard('C1:8.8', teammate('UTEAM0001'))
    assert.equal(s.hub.relayOk('C1:8.8'), true)
  })
})

describe('the owner commands', () => {
  test('confirm and revoke name what they changed, and refuse what they cannot find', () => {
    const s = setup()
    const id = s.store.addTrustLine({ who: 'UTEAM0001', kind: 'prod-read', reach: 'h', answer: 'yes', once: false, link: 'l' }, 1)
    assert.deepEqual(s.hub.command('revoke', id), { ok: true, text: `revoked ${id}` })
    assert.deepEqual(s.hub.command('revoke', id), { refused: `no line ${id} to revoke` })
    assert.deepEqual(s.hub.command('confirm', 'T99'), { refused: 'no proposed line T99' })
    assert.deepEqual(s.hub.command('confirm', 'all'), { refused: 'no proposed lines' })
    assert.deepEqual(s.hub.command('nope', 'all'), { refused: 'use confirm or revoke' })
  })
})
