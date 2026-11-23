import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startConnectors } from '../connectors.ts'
import { openLedgers } from '../../runtime/ledger.ts'
import { openStore } from '../../runtime/store.ts'

type Options = Parameters<typeof startConnectors>[0]

test('with no connector set up, every connector stays off, and replay reaches only slack and hooks', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kage-conn-'))
  const store = openStore(':memory:')
  const slackReplay = async () => 'slack'
  const slack = { ids: { botDm: 'DTEST1' }, replay: slackReplay, nameOf: async () => 'x', ownerName: 'Owner', notifyOwner: async () => true } as unknown as Options['slack']
  const d = { lastStartError: () => undefined, end: () => {}, hasFreeSlot: () => true } as unknown as Options['d']
  const said: string[] = []
  const c = startConnectors({ secrets: {} as Options['secrets'], conn: {}, store, slack, bot: {} as Options['bot'], ping: async () => true, say: async t => { said.push(t); return true },
    ownerAnswer: () => {}, NAME: 'Kage', CODE: dir, DIR: dir, d, inbox: { take: () => true, handled: () => {}, has: () => false }, emails: [],
    deliver: () => 'sent', placeOf: k => k, failed: () => {}, schedules: { add: () => {}, remove: () => {}, wake: () => {} } as unknown as Options['schedules'],
    event: () => {}, ledgers: openLedgers(dir), tripwires: {} })
  assert.deepEqual([c.github, c.meeting, c.email, c.voice, c.whatsapp, c.sms], [undefined, undefined, undefined, undefined, undefined, undefined])
  assert.equal(c.replayOf('slack'), slackReplay)
  assert.equal(c.replayOf('hook'), c.jobs.replay)
  for (const name of ['github', 'meeting', 'whatsapp', 'sms', 'email', 'voice']) assert.equal(c.replayOf(name), undefined, name)
  c.replies.voice('voice:1', 'hi')
  c.replies.sms('sms:1', 'hi')
  assert.deepEqual(said, [])
})
