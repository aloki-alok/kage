import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { decideAfk, outsider, parseAfk, parseStandIn, restoreTo, untilOf, type Afk } from './afk.ts'

const OWNER = 'UOWNER001'
const BOT = 'UBOT00001'
const DM = 'DBOT00001'
const ids = { owner: OWNER, bot: BOT, botDm: DM, name: 'kage' }
const NOW = Date.parse('2026-11-04T06:00:00Z')   // 11:30 IST
const IST = 'Asia/Kolkata'
const afk = (o: Partial<Afk> = {}): Afk => ({ since: NOW - 60_000, until: NOW + 3600_000, note: '', replies: {}, muted: [], pings: [], ...o })
const msg = (o: Record<string, unknown>) =>
  ({ channel: 'C1', ts: '1.1', user: 'UPEER0001', text: `<@${OWNER}> can you check this`, client_msg_id: 'c1', channel_type: 'channel', ...o })

describe('parseAfk: the owner turns it on and off', () => {
  test('afk alone, with a time, with a note', () => {
    assert.deepEqual(parseAfk('afk'), { kind: 'afk', note: '' })
    assert.deepEqual(parseAfk('AFK 2h'), { kind: 'afk', minutes: 120, note: '' })
    assert.deepEqual(parseAfk('afk 45 min in a meeting'), { kind: 'afk', minutes: 45, note: 'in a meeting' })
    assert.deepEqual(parseAfk('afk until 6pm, on a flight'), { kind: 'afk', at: { h: 18, m: 0 }, note: 'on a flight' })
    assert.deepEqual(parseAfk('afk till 18:30'), { kind: 'afk', at: { h: 18, m: 30 }, note: '' })
    assert.deepEqual(parseAfk('afk, dentist'), { kind: 'afk', note: 'dentist' })
  })
  test('the way people say it', () => {
    assert.deepEqual(parseAfk('kage im afk for 30 mins, take over'), { kind: 'afk', minutes: 30, note: 'take over' })
    assert.deepEqual(parseAfk("I'm going afk for 1 hour"), { kind: 'afk', minutes: 60, note: '' })
    assert.deepEqual(parseAfk('going afk till 6pm'), { kind: 'afk', at: { h: 18, m: 0 }, note: '' })
    assert.deepEqual(parseAfk("i'm back"), { kind: 'back' })
    assert.deepEqual(parseAfk('kage back'), { kind: 'back' })
  })
  test('back', () => {
    assert.deepEqual(parseAfk('back'), { kind: 'back' })
    assert.deepEqual(parseAfk('Back.'), { kind: 'back' })
  })
  test('ordinary tasks that start with the word stay tasks', () => {
    assert.equal(parseAfk('afk mode is broken, look at it'), null)
    assert.equal(parseAfk('back up the db'), null)
    assert.equal(parseAfk('afk until never'), null)
  })
})

describe('untilOf: when it ends', () => {
  test('minutes from now', () => {
    assert.equal(untilOf({ kind: 'afk', minutes: 90, note: '' }, NOW, IST), NOW + 90 * 60_000)
  })
  test('a clock time in the owner zone, today or tomorrow', () => {
    assert.equal(untilOf({ kind: 'afk', at: { h: 18, m: 0 }, note: '' }, NOW, IST), Date.parse('2026-11-04T12:30:00Z'))
    assert.equal(untilOf({ kind: 'afk', at: { h: 9, m: 0 }, note: '' }, NOW, IST), Date.parse('2026-11-05T03:30:00Z'))
  })
  test('no time means 12 hours, so a forgotten afk ends by itself', () => {
    assert.equal(untilOf({ kind: 'afk', note: '' }, NOW, IST), NOW + 12 * 3600_000)
  })
})

describe('decideAfk: what a heard message does while the owner is away', () => {
  test('a mention of the owner gets the stand-in, answered in its thread', () => {
    assert.deepEqual(decideAfk(msg({ ts: '5.5' }), afk(), ids, NOW), { kind: 'stand-in', key: 'C1:5.5', channel: 'C1', thread_ts: '5.5' })
    assert.deepEqual(decideAfk(msg({ ts: '6.6', thread_ts: '5.5' }), afk(), ids, NOW), { kind: 'stand-in', key: 'C1:5.5', channel: 'C1', thread_ts: '5.5' })
  })
  test('a DM to the owner gets the stand-in without a mention, outside a thread', () => {
    assert.deepEqual(decideAfk(msg({ channel: 'D9', channel_type: 'im', text: 'hey, quick one' }), afk(), ids, NOW),
      { kind: 'stand-in', key: 'D9', channel: 'D9', thread_ts: undefined })
  })
  test('a group DM needs the mention', () => {
    assert.equal(decideAfk(msg({ channel: 'G9', channel_type: 'mpim', text: 'lunch?' }), afk(), ids, NOW).kind, 'ignore')
  })
  test('nothing when not away, or when the time ran out', () => {
    assert.equal(decideAfk(msg({}), undefined, ids, NOW).kind, 'ignore')
    assert.equal(decideAfk(msg({}), afk({ until: NOW }), ids, NOW).kind, 'ignore')
  })
  test('bots, apps, edits and Kage itself never get an answer', () => {
    for (const o of [{ bot_id: 'B1' }, { app_id: 'A1' }, { client_msg_id: undefined }, { subtype: 'message_changed' }, { user: BOT }]) {
      assert.equal(decideAfk(msg(o), afk(), ids, NOW).kind, 'ignore', JSON.stringify(o))
    }
  })
  test('a message tagging Kage is a task for the gate, not for the stand-in', () => {
    assert.equal(decideAfk(msg({ text: `<@${OWNER}> <@${BOT}> deploy` }), afk(), ids, NOW).kind, 'ignore')
    assert.equal(decideAfk(msg({ text: `<@${OWNER}> @kage deploy` }), afk(), ids, NOW).kind, 'ignore')
  })
  test('the owner typing somewhere mutes that conversation', () => {
    assert.deepEqual(decideAfk(msg({ user: OWNER, text: 'on it' }), afk(), ids, NOW), { kind: 'mute', channel: 'C1' })
    assert.equal(decideAfk(msg({}), afk({ muted: ['C1'] }), ids, NOW).kind, 'ignore')
    assert.equal(decideAfk(msg({ channel: 'C2' }), afk({ muted: ['C1'] }), ids, NOW).kind, 'stand-in')
  })
  test('the owner in the Kage DM or an app with his token does not mute', () => {
    assert.equal(decideAfk(msg({ user: OWNER, channel: DM }), afk(), ids, NOW).kind, 'ignore')
    assert.equal(decideAfk(msg({ user: OWNER, client_msg_id: undefined }), afk(), ids, NOW).kind, 'ignore')
  })
  test('5 replies per thread, then silence', () => {
    assert.equal(decideAfk(msg({ ts: '5.5' }), afk({ replies: { 'C1:5.5': 4 } }), ids, NOW).kind, 'stand-in')
    assert.equal(decideAfk(msg({ ts: '5.5' }), afk({ replies: { 'C1:5.5': 5 } }), ids, NOW).kind, 'ignore')
  })
})

describe('outsider: who never gets an answer', () => {
  test('guests, Slack Connect people, bots, shared or customer channels', () => {
    assert.equal(outsider({ team_id: 'T1' }, { name: 'engineering' }, 'T1'), false)
    assert.equal(outsider({ team_id: 'T2' }, { name: 'engineering' }, 'T1'), true)
    assert.equal(outsider({ team_id: 'T1',  is_restricted: true }, { name: 'eng' }, 'T1'), true)
    assert.equal(outsider({ team_id: 'T1',  is_ultra_restricted: true }, { name: 'eng' }, 'T1'), true)
    assert.equal(outsider({ team_id: 'T1',  is_stranger: true }, { name: 'eng' }, 'T1'), true)
    assert.equal(outsider({ team_id: 'T1',  is_bot: true }, { name: 'eng' }, 'T1'), true)
    assert.equal(outsider({ team_id: 'T1' }, { name: 'eng', is_ext_shared: true }, 'T1'), true)
    assert.equal(outsider({ team_id: 'T1' }, { name: 'customer-support' }, 'T1'), true)
    assert.equal(outsider({ team_id: 'T1' }, {}, 'T1'), false)
  })
  test('an unknown person or channel counts as an outsider', () => {
    assert.equal(outsider(undefined, { name: 'eng' }, 'T1'), true)
    assert.equal(outsider({ team_id: 'T1' }, undefined, 'T1'), true)
    assert.equal(outsider({}, { name: 'eng' }, 'T1'), true)
  })
})

describe('parseStandIn: what the stand-in wrote', () => {
  test('reply, note and waits', () => {
    assert.deepEqual(parseStandIn('REPLY: Maya is away till 6.\nHe will check the PR then.\nNOTE: Sam wants #42 reviewed\nWAITS: yes'),
      { reply: 'Maya is away till 6.\nHe will check the PR then.', note: 'Sam wants #42 reviewed', waits: true })
    assert.deepEqual(parseStandIn('REPLY: hi\nNOTE: said hi\nWAITS: no'), { reply: 'hi', note: 'said hi', waits: false })
  })
  test('anything else posts nothing', () => {
    assert.equal(parseStandIn('Sure, here is my reply: hi'), null)
    assert.equal(parseStandIn('REPLY:\nNOTE: x\nWAITS: no'), null)
    assert.equal(parseStandIn('REPLY: hi'), null)
  })
})

describe('restoreTo: the status when the owner is back', () => {
  const ours = 'Away until 6:00 pm. Kage is covering'
  const prior = { status_text: 'In Bangalore', status_emoji: ':airplane:', status_expiration: 0 }
  test('ours, or cleared by its own expiry, goes back to the old one', () => {
    assert.deepEqual(restoreTo({ status_text: ours }, ours, prior, NOW), prior)
    assert.deepEqual(restoreTo({ status_text: '' }, ours, prior, NOW), prior)
  })
  test('an old status that has expired meanwhile is cleared instead', () => {
    assert.deepEqual(restoreTo({ status_text: ours }, ours, { ...prior, status_expiration: NOW / 1000 - 1 }, NOW), { status_text: '', status_emoji: '', status_expiration: 0 })
    assert.deepEqual(restoreTo({ status_text: ours }, ours, undefined, NOW), { status_text: '', status_emoji: '', status_expiration: 0 })
  })
  test('a status the owner set meanwhile stays', () => {
    assert.equal(restoreTo({ status_text: 'Lunch' }, ours, prior, NOW), undefined)
  })
})
