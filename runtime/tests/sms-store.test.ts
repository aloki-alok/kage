import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { openSmsStore } from '../sms-store.ts'

const A = '+14155550101', B = '+14155550102', C = '+14155550103'
const fresh = () => openSmsStore(':memory:', () => '2026-11-22T15:00:00.000Z')
const launched = (s = fresh(), phones = [A, B, C]) => {
  const { id } = s.createCampaign({ name: 'promo', body: 'Sale ends Friday. Reply STOP to opt out.', thread: 'D0TEST1:1.1', phones })
  assert.equal(s.move(id, 'launch'), 'sending')
  return { s, id }
}

describe('a campaign and its contacts', () => {
  test('a repeated number is kept once, and the campaign starts as a draft', () => {
    const s = fresh()
    const made = s.createCampaign({ name: 'promo', body: 'hi', thread: 'D0TEST1:1.1', phones: [A, B, A] })
    assert.deepEqual({ added: made.added, repeated: made.repeated }, { added: 2, repeated: 1 })
    assert.equal(s.campaign(made.id)?.state, 'draft')
    assert.deepEqual(s.nextBatch(10), [])
  })
  test('an illegal step or an unknown campaign changes nothing', () => {
    const { s, id } = launched()
    assert.equal(s.move(id, 'launch'), undefined)
    assert.equal(s.campaign(id)?.state, 'sending')
    assert.equal(s.move(999, 'pause'), undefined)
  })
  test('the list shows the newest campaigns first', () => {
    const s = fresh()
    s.createCampaign({ name: 'first', body: 'hi', thread: 'D0TEST1:1.1', phones: [A] })
    s.createCampaign({ name: 'second', body: 'hi', thread: 'D0TEST1:1.1', phones: [A] })
    assert.deepEqual(s.campaigns(5).map(c => c.name), ['second', 'first'])
  })
})

describe('sending a campaign', () => {
  test('a batch holds only contacts never claimed, up to the limit, oldest campaign first', () => {
    const { s, id } = launched()
    const batch = s.nextBatch(2)
    assert.deepEqual(batch.map(b => b.phone), [A, B])
    for (const b of batch) assert.ok(s.claim(b.campaign, b.person, 1))
    assert.deepEqual(s.nextBatch(5).map(b => [b.campaign, b.phone]), [[id, C]])
  })
  test('a contact is claimed once: a second claim, as after a crash between claim and send, gets nothing', () => {
    const { s } = launched()
    const [first] = s.nextBatch(1)
    assert.ok(s.claim(first!.campaign, first!.person, 1))
    assert.equal(s.claim(first!.campaign, first!.person, 1), undefined)
  })
  test('a paused campaign sends nothing until it resumes', () => {
    const { s, id } = launched()
    s.move(id, 'pause')
    assert.deepEqual(s.nextBatch(5), [])
    s.move(id, 'resume')
    assert.equal(s.nextBatch(5).length, 3)
  })
  test('an opted-out number is skipped, never sent, and counted in the report', () => {
    const s = fresh()
    s.optOut(s.person(B))
    const { id } = launched(s)
    assert.deepEqual(s.nextBatch(5).map(b => b.phone), [A, C])
    assert.equal(s.report(id)!.counts.skipped, 1)
  })
  test('a campaign is listed as sent once every contact has a row, and stays sending until it is moved to done', () => {
    const { s, id } = launched(fresh(), [A])
    assert.deepEqual(s.sentCampaigns(), [])
    const [b] = s.nextBatch(1)
    s.claim(b!.campaign, b!.person, 1)
    assert.deepEqual(s.sentCampaigns(), [id])
    assert.equal(s.campaign(id)?.state, 'sending')
    s.move(id, 'finish')
    assert.deepEqual(s.sentCampaigns(), [])
  })
  test('a claim for a campaign that is no longer sending gets nothing', () => {
    for (const action of ['pause', 'cancel'] as const) {
      const { s, id } = launched()
      const [b] = s.nextBatch(1)
      s.move(id, action)
      assert.equal(s.claim(b!.campaign, b!.person, 1), undefined, action)
    }
  })
  test('a claim for a number that opted out after the batch was read gets nothing, for a campaign or a reply', () => {
    const { s } = launched()
    const [b] = s.nextBatch(1)
    s.optOut(b!.person)
    assert.equal(s.claim(b!.campaign, b!.person, 1), undefined)
    assert.equal(s.claim(null, b!.person, 1), undefined)
  })
  test('a released claim frees the contact for the next batch, and a row the provider took is never released', () => {
    const { s } = launched(fresh(), [A, B])
    const [a, b] = s.nextBatch(2)
    const rowA = s.claim(a!.campaign, a!.person, 1)!
    const rowB = s.claim(b!.campaign, b!.person, 1)!
    s.accepted(rowB, 'SM0TEST9')
    s.release(rowA)
    s.release(rowB)
    assert.deepEqual(s.nextBatch(5).map(x => x.phone), [A])
  })
})

describe('tracking what happened to each text', () => {
  test('status callbacks move a message forward only, and a late one cannot undo delivered', () => {
    const { s, id } = launched(fresh(), [A])
    const [b] = s.nextBatch(1)
    const row = s.claim(b!.campaign, b!.person, 2)!
    s.accepted(row, 'SM0TEST1')
    assert.equal(s.status('SM0TEST1', 'delivered'), true)
    assert.equal(s.status('SM0TEST1', 'sent'), true)
    assert.equal(s.status('SM0TEST9', 'delivered'), false)
    assert.equal(s.report(id)!.counts.delivered, 1)
    assert.equal(s.report(id)!.segments, 2)
  })
  test('a provider refusal is a failed row with its code, and failed rows bill no segments', () => {
    const { s, id } = launched(fresh(), [A, B])
    const [a, b] = s.nextBatch(2)
    s.refused(s.claim(a!.campaign, a!.person, 1)!, '21610')
    const rowB = s.claim(b!.campaign, b!.person, 1)!
    s.accepted(rowB, 'SM0TEST2')
    s.status('SM0TEST2', 'undelivered', '30007')
    const r = s.report(id)!
    assert.deepEqual(r.errors, { 21610: 1, 30007: 1 })
    assert.deepEqual([r.counts.failed, r.counts.undelivered, r.segments], [1, 1, 1])
  })
  test('a reply is tied to the last campaign that texted that number, and counted', () => {
    const { s, id } = launched(fresh(), [A])
    const [b] = s.nextBatch(1)
    s.accepted(s.claim(b!.campaign, b!.person, 1)!, 'SM0TEST3')
    const heard = s.heard(A, 'SM0TEST4')
    assert.deepEqual(heard, { person: s.person(A), campaign: id, fresh: true })
    assert.equal(s.heard(A, 'SM0TEST4').fresh, false)
    assert.equal(s.heard(C, 'SM0TEST5').campaign, undefined)
    assert.equal(s.report(id)!.replies, 1)
  })
  test('a STOP reply opts the number out and counts for the campaign, not as a reply, and START lifts it', () => {
    const { s, id } = launched(fresh(), [A])
    const [b] = s.nextBatch(1)
    s.accepted(s.claim(b!.campaign, b!.person, 1)!, 'SM0TEST6')
    s.heard(A, 'SM0TEST7', 'stop')
    assert.equal(s.claim(null, s.person(A), 1), undefined)
    assert.deepEqual([s.report(id)!.optOuts, s.report(id)!.replies], [1, 0])
    s.heard(A, 'SM0TEST8', 'start')
    assert.ok(s.claim(null, s.person(A), 1))
    assert.equal(s.report(id)!.optOuts, 1)
  })
  test('a resent STOP is counted once', () => {
    const { s, id } = launched(fresh(), [A])
    const [b] = s.nextBatch(1)
    s.accepted(s.claim(b!.campaign, b!.person, 1)!, 'SM0TEST6')
    s.heard(A, 'SM0TEST7', 'stop')
    s.heard(A, 'SM0TEST7', 'stop')
    assert.equal(s.report(id)!.optOuts, 1)
  })
  test('a one-off reply to a text is tracked like a campaign text, outside any campaign', () => {
    const s = fresh()
    const first = s.claim(null, s.person(A), 1)!
    const second = s.claim(null, s.person(A), 1)!
    assert.notEqual(first, second)
    s.accepted(first, 'SM0TEST9')
    assert.equal(s.status('SM0TEST9', 'delivered'), true)
  })
  test('a contact id maps back to its number for a reply, and a person is one id across campaigns', () => {
    const s = fresh()
    assert.equal(s.person(A), s.person(A))
    assert.equal(s.phoneOf(s.person(A)), A)
    assert.equal(s.phoneOf(999), undefined)
  })
})

test('the tables live in kage.db and survive a reopen', () => {
  const dir = mkdtempSync(`${tmpdir()}/kage-sms-`)
  const first = openSmsStore(`${dir}/kage.db`)
  const { id } = first.createCampaign({ name: 'promo', body: 'hi', thread: 'D0TEST1:1.1', phones: [A] })
  first.close()
  assert.equal(openSmsStore(`${dir}/kage.db`).campaign(id)?.name, 'promo')
})
