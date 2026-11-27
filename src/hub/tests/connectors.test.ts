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
    event: () => {}, ledgers: openLedgers(dir), tripwires: {}, posted: () => {}, cardOpen: () => false })
  assert.deepEqual([c.github, c.meeting, c.email, c.voice, c.siri, c.whatsapp, c.sms], [undefined, undefined, undefined, undefined, undefined, undefined, undefined])
  assert.equal(c.replayOf('slack'), slackReplay)
  assert.equal(c.replayOf('hook'), c.jobs.replay)
  for (const name of ['github', 'meeting', 'whatsapp', 'sms', 'email', 'voice']) assert.equal(c.replayOf(name), undefined, name)
  c.replies.voice('voice:1', 'hi')
  c.replies.sms('sms:1', 'hi')
  assert.deepEqual(said, [])
})

test('a Siri ask opens its own DM thread under a Kage post, runs the words as the owner in it, and speaks that thread\'s answer', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kage-conn-'))
  const heads: { channel: string; text: string }[] = []
  const said: { text: string; at?: { channel: string; thread_ts: string; kind: string } }[] = []
  const posted: { cells: string[]; kind: string }[] = []
  const carded = new Set<string>()
  const slack = { ids: { botDm: 'DTEST1' }, replay: async () => '', nameOf: async () => 'x', ownerName: 'Owner', notifyOwner: async () => true,
    say: async (text: string, at?: { channel: string; thread_ts: string; kind: string }) => { said.push({ text, at }); return { channel: 'DTEST1', ts: '200.1' } } } as unknown as Options['slack']
  const bot = { chat: { postMessage: async (m: { channel: string; text: string }) => { heads.push(m); return { ts: '100.1' } } } } as unknown as Options['bot']
  const d = { lastStartError: () => undefined, end: () => {}, hasFreeSlot: () => true, status: () => ({ live: [] }) } as unknown as Options['d']
  const c = startConnectors({ secrets: { siriToken: 'siri-tok-1234567890' } as Options['secrets'], conn: { siri: { port: 0, waitSeconds: 5 } }, store: openStore(':memory:'), slack, bot, ping: async () => true, say: async () => true,
    ownerAnswer: () => {}, NAME: 'Kage', CODE: dir, DIR: dir, d, inbox: { take: () => true, handled: () => {}, has: () => false }, emails: [],
    deliver: () => 'sent', placeOf: k => k, failed: () => {}, schedules: { add: () => {}, remove: () => {}, wake: () => {} } as unknown as Options['schedules'],
    event: () => {}, ledgers: openLedgers(dir), tripwires: {}, posted: (cells, kind) => posted.push({ cells, kind }), cardOpen: key => carded.has(key) })
  try {
    const port = await c.siri!.listening
    const pending = fetch(`http://127.0.0.1:${port}/ask`, { method: 'POST', headers: { Authorization: 'Bearer siri-tok-1234567890' }, body: JSON.stringify({ text: 'is the build green' }) }).then(r => r.json())
    for (let i = 0; i < 200 && !said.length; i++) await new Promise(r => setTimeout(r, 10))
    assert.deepEqual(heads.map(h => h.channel), ['DTEST1'])
    assert.match(heads[0]!.text, /is the build green/)
    assert.deepEqual(posted, [{ cells: ['DTEST1', '100.1', 'bot', 'DTEST1:100.1'], kind: 'notice:siri' }])
    assert.deepEqual(said[0]!.at, { channel: 'DTEST1', thread_ts: '100.1', kind: 'dm' })
    assert.match(said[0]!.text, /From Siri, heard, not typed: is the build green/)
    c.siri!.ended('DTEST1:100.1', () => [{ text: 'Yes, main is green.' }])
    assert.deepEqual(await pending, { state: 'answered', say: 'Yes, main is green.' })
    carded.add('DTEST1:100.1')
    const card = fetch(`http://127.0.0.1:${port}/ask`, { method: 'POST', headers: { Authorization: 'Bearer siri-tok-1234567890' }, body: JSON.stringify({ text: 'deploy it' }) }).then(r => r.json())
    for (let i = 0; i < 200 && said.length < 2; i++) await new Promise(r => setTimeout(r, 10))
    c.siri!.ended('DTEST1:100.1', () => [])
    assert.equal((await card).state, 'approval')
  } finally { await c.siri!.close() }
})
