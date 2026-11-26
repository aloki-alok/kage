import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ownerChannel } from '../owner-channel.ts'

const setup = (pick: 'slack' | 'whatsapp' | undefined, wa?: (t: string) => Promise<boolean>) => {
  const sent: string[] = []
  const slack = async (t: string) => { sent.push(`slack: ${t}`); return true }
  const whatsapp = wa && (async (t: string) => { const ok = await wa(t); if (ok) sent.push(`whatsapp: ${t}`); return ok })
  return { sent, owner: ownerChannel({ pick: () => pick, slack, ...(whatsapp && { whatsapp }) }) }
}

test('with no choice, the owner hears on Slack', async () => {
  const t = setup(undefined, async () => true)
  assert.equal(await t.owner.say('hi'), true)
  assert.deepEqual(t.sent, ['slack: hi'])
})
test('with whatsapp chosen, the owner hears on WhatsApp only', async () => {
  const t = setup('whatsapp', async () => true)
  await t.owner.say('hi')
  assert.deepEqual(t.sent, ['whatsapp: hi'])
})
test('if the WhatsApp send fails or throws, the same text goes to Slack, so nothing is lost', async () => {
  const failed = setup('whatsapp', async () => false)
  await failed.owner.say('one')
  const threw = setup('whatsapp', async () => { throw new Error('bridge down') })
  assert.equal(await threw.owner.say('two'), true)
  assert.deepEqual([...failed.sent, ...threw.sent], ['slack: one', 'slack: two'])
})
test('a line that reached the owner on WhatsApp is reported once, so it counts as a post; one that fell back to Slack is not (#242)', async () => {
  const told: string[] = []
  const owner = (ok: boolean) => ownerChannel({ pick: () => 'whatsapp', slack: async () => true, whatsapp: async () => ok, onWhatsapp: t => told.push(t) })
  await owner(true).say('sent')
  await owner(false).say('fell back')
  assert.deepEqual(told, ['sent'])
})
test('with whatsapp chosen but not running, the owner hears on Slack', async () => {
  const t = setup('whatsapp')
  await t.owner.say('hi')
  assert.deepEqual(t.sent, ['slack: hi'])
})
