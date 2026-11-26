import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { filesFolderName } from '../../core/conversations.ts'
import { openLedgers } from '../ledger.ts'
import { sessionTools } from '../kage-tools.ts'
import { openSmsStore } from '../sms-store.ts'
import type { Task } from '../../core/task.ts'

const BODY = 'Spring sale this week. Reply STOP to opt out.'

function setup(o: { yes?: boolean; kagelet?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'kage-sms-tools-'))
  const sms = openSmsStore(join(dir, 'kage.db'))
  const cards: string[] = []
  const slack = { reactions: { add: async () => {}, remove: async () => {} } }
  const t = sessionTools({
    title: 'Kage', owner: () => 'UOWNER', bot: slack as any, user: slack as any, botDm: () => 'DBOT', dir, ledgers: openLedgers(dir), send: () => {}, memory: { own: '/own', owner: '/owner' },
    kagelet: o.kagelet, sms,
    approve: async (_tool, description) => { cards.push(description); return o.yes ?? true },
  })
  const task = (fromOwner = true): Task => ({ type: 'task', content: 'Task from Sam: text them', fromOwner, meta: { channel: 'C1', thread_ts: '5.5', place: '#general', permalink: '' }, origin: { channel: 'C1', ts: '5.5' } })
  const tool = t.tools.find(x => x.name === 'sms_campaign')
  const call = (args: Record<string, unknown>) => tool!.run({ channel: 'C1', thread_ts: '5.5', ...args })
  return { dir, sms, cards, t, task, tool, call }
}

test('create: numbers become a draft tied to the task thread, bad and repeated numbers are counted, nothing sends', async () => {
  const s = setup()
  s.t.onTask(s.task())
  const r = await s.call({ action: 'create', name: 'Spring', body: BODY, numbers: ['(415) 555-0101', '+14155550101', '415 555 0102', 'not a number'] })
  assert.equal(r.isError, undefined, r.text)
  assert.match(r.text, /campaign 1/)
  assert.match(r.text, /2 contacts/)
  assert.match(r.text, /1 repeated/)
  assert.match(r.text, /1 not a US number/)
  const c = s.sms.campaign(1)!
  assert.deepEqual([c.state, c.thread, c.body], ['draft', 'C1:5.5', BODY])
  assert.equal(s.sms.nextBatch(10).length, 0)
})

test('create: a CSV in the thread files folder is read, and a path outside it is refused', async () => {
  const s = setup()
  s.t.onTask(s.task())
  const folder = join(s.dir, 'files', filesFolderName('C1', '5.5'))
  mkdirSync(folder, { recursive: true })
  writeFileSync(join(folder, 'list.csv'), 'name,phone\nAna,4155550101\nBo,+1 415 555 0102\nCy,\n')
  const r = await s.call({ action: 'create', name: 'Spring', body: BODY, file: 'list.csv' })
  assert.equal(r.isError, undefined, r.text)
  assert.match(r.text, /2 contacts/)
  assert.match(r.text, /2 lines with no US number/)
  writeFileSync(join(s.dir, 'secret.csv'), '4155550103\n')
  const out = await s.call({ action: 'create', name: 'X', body: BODY, file: '../../secret.csv' })
  assert.equal(out.isError, true)
  assert.equal(s.sms.campaigns(10).length, 1)
})

test('create: a text with no way to opt out is refused', async () => {
  const s = setup()
  s.t.onTask(s.task())
  const r = await s.call({ action: 'create', name: 'Spring', body: 'Spring sale this week.', numbers: ['4155550101'] })
  assert.equal(r.isError, true)
  assert.match(r.text, /STOP/)
})

test('launch: sends only after the owner says yes on a card that shows the count and the text', async () => {
  const no = setup({ yes: false })
  no.t.onTask(no.task())
  await no.call({ action: 'create', name: 'Spring', body: BODY, numbers: ['4155550101', '4155550102'] })
  const refused = await no.call({ action: 'launch', campaign: 1 })
  assert.equal(refused.isError, true)
  assert.equal(no.sms.campaign(1)!.state, 'draft')
  assert.match(no.cards[0]!, /2 contacts/)
  assert.ok(no.cards[0]!.includes(BODY))
  const yes = setup()
  yes.t.onTask(yes.task())
  await yes.call({ action: 'create', name: 'Spring', body: BODY, numbers: ['4155550101'] })
  assert.equal((await yes.call({ action: 'launch', campaign: 1 })).isError, undefined)
  assert.equal(yes.sms.campaign(1)!.state, 'sending')
  assert.equal(yes.sms.nextBatch(10).length, 1)
})

test('pause, resume, cancel and report move the campaign by its legal steps', async () => {
  const s = setup()
  s.t.onTask(s.task())
  await s.call({ action: 'create', name: 'Spring', body: BODY, numbers: ['4155550101'] })
  assert.equal((await s.call({ action: 'pause', campaign: 1 })).isError, true)
  await s.call({ action: 'launch', campaign: 1 })
  assert.equal((await s.call({ action: 'pause', campaign: 1 })).isError, undefined)
  assert.equal(s.sms.campaign(1)!.state, 'paused')
  await s.call({ action: 'resume', campaign: 1 })
  assert.equal(s.sms.campaign(1)!.state, 'sending')
  assert.match((await s.call({ action: 'report', campaign: 1 })).text, /Spring: sending\.\n1 contacts/)
  assert.match((await s.call({ action: 'list' })).text, /#1 Spring \(sending\)/)
  await s.call({ action: 'cancel', campaign: 1 })
  assert.equal(s.sms.campaign(1)!.state, 'cancelled')
  assert.equal((await s.call({ action: 'report', campaign: 9 })).isError, true)
})

test('only the owner\'s own task runs a campaign, and a kagelet never gets the tool', async () => {
  const s = setup()
  s.t.onTask(s.task(false))
  const r = await s.call({ action: 'create', name: 'Spring', body: BODY, numbers: ['4155550101'] })
  assert.equal(r.isError, true)
  assert.equal(s.sms.campaigns(10).length, 0)
  assert.equal(setup({ kagelet: 'watcher' }).tool, undefined)
})
