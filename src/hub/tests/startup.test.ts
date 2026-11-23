import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { importCrons, replayMissed } from '../startup.ts'
import { whatsappCards } from '../whatsapp-cards.ts'
import { callOwner } from '../phone-owner.ts'

const flush = () => new Promise(r => setTimeout(r, 10))

test('cron jobs exported from the panes are adopted once, wait while panes still run, and a bad file is set aside with one note', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kage-crons-'))
  const adopted: unknown[] = [], told: string[] = []
  const schedules = { adopt: (jobs: unknown[], ranUntil: number) => { adopted.push([jobs, ranUntil]); return { adopted: jobs as never[], skipped: [] } } }
  writeFileSync(join(dir, 'crons-import.json'), JSON.stringify({ jobs: [{ id: 'j1' }], ranUntil: 5 }))
  importCrons(dir, 2, schedules, t => told.push(t))
  assert.deepEqual(adopted, [])
  importCrons(dir, 0, schedules, t => told.push(t))
  assert.deepEqual(adopted, [[[{ id: 'j1' }], 5]])
  assert.equal(existsSync(join(dir, 'crons-import.json.imported')), true)
  writeFileSync(join(dir, 'crons-import.json'), '{not json')
  importCrons(dir, 0, schedules, t => told.push(t))
  assert.equal(existsSync(join(dir, 'crons-import.json.bad')), true)
  assert.equal(told.length, 1)
})

test('a message the last run heard but never handled replays through its connector, or is marked handled when the connector is off', async () => {
  const handled: string[] = [], replayed: string[] = []
  const store = { unhandled: (since: number) => { assert.equal(since, 1_000_000 - 600_000); return [{ source: 's1', connector: 'slack', payload: 'p1', at: 0 }, { source: 's2', connector: 'sms', payload: 'p2', at: 0 }] }, handled: (s: string) => { handled.push(s) } }
  replayMissed(store, c => c === 'slack' ? async (source, payload) => { replayed.push(`${source} ${payload}`) } : undefined, 1_000_000)
  await flush()
  assert.deepEqual(replayed, ['s1 p1'])
  assert.deepEqual(handled, ['s2'])
})

test('an approval card goes to WhatsApp only when the owner picked it, and a reply code answers that card once', async () => {
  const sent: string[] = [], verdicts: string[] = []
  let channel = 'slack', ok = true
  const cards = whatsappCards({ channel: () => channel, say: async t => { sent.push(t); return ok }, name: 'Kage', verdict: (id, b) => { verdicts.push(`${id} ${b}`); return id === 'card1' } })
  const card = { id: 'card1', tool: 'Bash', description: 'deploy', place: '#ops', preview: 'kubectl apply' }
  cards.send(card)
  assert.deepEqual(sent, [])
  channel = 'whatsapp'
  cards.send(card)
  await flush()
  const code = /yes (\d{4})/.exec(sent[0]!)![1]!
  cards.answer({ code, behavior: 'allow' })
  cards.answer({ code, behavior: 'allow' })
  await flush()
  assert.deepEqual(verdicts, ['card1 allow'])
  assert.deepEqual(sent.slice(1), ['Approved.', `No card waits on ${code}.`])
  ok = false
  cards.send({ ...card, id: 'card2' })
  await flush()
  const lost = /yes (\d{4})/.exec(sent.at(-1)!)![1]!
  cards.answer({ code: lost, behavior: 'deny' })
  await flush()
  assert.equal(sent.at(-1), `No card waits on ${lost}.`)
})

test('the owner call needs a dialer command and voice, passes the call code and reason, and reports a failing dialer', async () => {
  const voice = { issueCode: () => '1234' }
  assert.equal(await callOwner(undefined, voice, 'r'), 'no connectors.call.command')
  assert.equal(await callOwner('true', undefined, 'r'), 'voice is off (voiceToken)')
  const dir = mkdtempSync(join(tmpdir(), 'kage-call-'))
  assert.equal(await callOwner(`printf "%s %s" "$KAGE_CALL_CODE" "$KAGE_CALL_REASON" > ${dir}/out`, voice, 'the deploy is stuck'), '')
  assert.equal(readFileSync(join(dir, 'out'), 'utf8'), '1234 the deploy is stuck')
  assert.equal(await callOwner('exit 3', voice, 'r'), 'dialer exited 3')
})
