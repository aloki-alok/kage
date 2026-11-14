import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { actOn, awayCommand, BURST, CALL_GAP, decideAfk, MAX_REPLIES, noteMention, notePing, outsider, parseTriage, restoreTo, untilOf, type Afk, type Ping, type Urgency, type Watch } from '../afk.ts'

const OWNER = 'UOWNER001'
const BOT = 'UBOT00001'
const DM = 'DBOT00001'
const ids = { owner: OWNER, bot: BOT, botDm: DM, name: 'kage' }
const NOW = Date.parse('2026-11-04T06:00:00Z')   // 11:30 IST
const IST = 'Asia/Kolkata'
const afk = (o: Partial<Afk> = {}): Afk => ({ since: NOW - 60_000, until: NOW + 3600_000, note: '', replies: {}, muted: [], watch: {}, pings: [], ...o })
const watch = (o: Partial<Watch> = {}): Watch => ({ channel: 'C1', thread_ts: '5.5', mentions: 1, ...o })
const ping = (o: Partial<Ping> = {}): Ping => ({ key: 'C1:5.5', when: NOW, who: 'Sam', place: '#eng', link: '', note: '', waits: false, urgency: 'normal', ...o })
const msg = (o: Record<string, unknown>) =>
  ({ channel: 'C1', ts: '1.1', user: 'UPEER0001', text: `<@${OWNER}> can you check this`, client_msg_id: 'c1', channel_type: 'channel', ...o })

describe('awayCommand: what the away tool was given', () => {
  test('minutes, a 24-hour clock time, or neither', () => {
    assert.deepEqual(awayCommand({ minutes: 60, note: 'lunch' }), { kind: 'afk', minutes: 60, note: 'lunch' })
    assert.deepEqual(awayCommand({ until: '18:30', note: '' }), { kind: 'afk', at: { h: 18, m: 30 }, note: '' })
    assert.deepEqual(awayCommand({ until: '9:05' }), { kind: 'afk', at: { h: 9, m: 5 }, note: '' })
    assert.deepEqual(awayCommand({}), { kind: 'afk', note: '' })
  })
  test('a time it cannot read is refused, not guessed', () => {
    for (const a of [{ until: '6pm' }, { until: '25:00' }, { until: '18:75' }, { minutes: 0 }, { minutes: -5 }, { minutes: 2.5 }]) {
      assert.equal(typeof awayCommand(a), 'string', JSON.stringify(a))
    }
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
  test('a mention of the owner starts a triage of its thread', () => {
    assert.deepEqual(decideAfk(msg({ ts: '5.5' }), afk(), ids, NOW), { kind: 'triage', key: 'C1:5.5', channel: 'C1', thread_ts: '5.5', mentioned: true })
    assert.deepEqual(decideAfk(msg({ ts: '6.6', thread_ts: '5.5' }), afk(), ids, NOW), { kind: 'triage', key: 'C1:5.5', channel: 'C1', thread_ts: '5.5', mentioned: true })
  })
  test('a watched thread is triaged again on every message, mention or not', () => {
    const plain = msg({ ts: '7.7', thread_ts: '5.5', text: 'any update?' })
    assert.deepEqual(decideAfk(plain, afk({ watch: { 'C1:5.5': watch() } }), ids, NOW), { kind: 'triage', key: 'C1:5.5', channel: 'C1', thread_ts: '5.5', mentioned: false })
    assert.equal(decideAfk(plain, afk(), ids, NOW).kind, 'ignore')
  })
  test('a DM to the owner counts as a mention, keyed by the DM', () => {
    assert.deepEqual(decideAfk(msg({ channel: 'D9', channel_type: 'im', text: 'hey, quick one' }), afk(), ids, NOW),
      { kind: 'triage', key: 'D9', channel: 'D9', thread_ts: undefined, mentioned: true })
  })
  test('a group DM needs the mention', () => {
    assert.equal(decideAfk(msg({ channel: 'G9', channel_type: 'mpim', text: 'lunch?' }), afk(), ids, NOW).kind, 'ignore')
  })
  test('nothing when not away, or when the time ran out', () => {
    assert.equal(decideAfk(msg({}), undefined, ids, NOW).kind, 'ignore')
    assert.equal(decideAfk(msg({}), afk({ until: NOW }), ids, NOW).kind, 'ignore')
  })
  test('bots, apps, edits and Kage itself never start a triage', () => {
    for (const o of [{ bot_id: 'B1' }, { app_id: 'A1' }, { client_msg_id: undefined }, { subtype: 'message_changed' }, { user: BOT }]) {
      assert.equal(decideAfk(msg(o), afk(), ids, NOW).kind, 'ignore', JSON.stringify(o))
    }
  })
  test('a message tagging Kage is a task for the gate, not for the stand-in', () => {
    assert.equal(decideAfk(msg({ text: `<@${OWNER}> <@${BOT}> deploy` }), afk(), ids, NOW).kind, 'ignore')
    assert.equal(decideAfk(msg({ text: `<@${OWNER}> @kage deploy` }), afk(), ids, NOW).kind, 'ignore')
  })
  test('the owner typing in a thread mutes that thread only', () => {
    assert.deepEqual(decideAfk(msg({ user: OWNER, ts: '6.6', thread_ts: '5.5', text: 'on it' }), afk(), ids, NOW), { kind: 'mute', key: 'C1:5.5' })
    assert.equal(decideAfk(msg({ ts: '7.7', thread_ts: '5.5' }), afk({ muted: ['C1:5.5'] }), ids, NOW).kind, 'ignore')
    assert.equal(decideAfk(msg({ ts: '8.8' }), afk({ muted: ['C1:5.5'] }), ids, NOW).kind, 'triage')
  })
  test('the owner in the Kage DM or an app with their token does not mute', () => {
    assert.equal(decideAfk(msg({ user: OWNER, channel: DM }), afk(), ids, NOW).kind, 'ignore')
    assert.equal(decideAfk(msg({ user: OWNER, client_msg_id: undefined }), afk(), ids, NOW).kind, 'ignore')
  })
})

describe('actOn: post, call, or only track', () => {
  const t = (urgency: Urgency, w = watch(), a = afk(), o = false, repeat = false) => actOn(urgency, repeat, 'C1:5.5', w, a, NOW, o)
  test('a first mention that can wait is only tracked', () => {
    assert.deepEqual(t('normal'), { post: false, call: false })
    assert.deepEqual(t('low'), { post: false, call: false })
  })
  test('a repeat mention gets a reply; later chatter in the thread does not', () => {
    assert.deepEqual(t('normal', watch({ mentions: 2 }), afk(), false, true), { post: true, call: false })
    assert.deepEqual(t('normal', watch({ mentions: 2 }), afk(), false, false), { post: false, call: false })
  })
  test('high takes over at once; p0 also phones the owner', () => {
    assert.deepEqual(t('high'), { post: true, call: false })
    assert.deepEqual(t('p0'), { post: true, call: true })
  })
  test('one call per thread, and none within CALL_GAP of the last', () => {
    assert.deepEqual(t('p0', watch({ called: true })), { post: true, call: false })
    assert.deepEqual(t('p0', watch(), afk({ lastCall: NOW - CALL_GAP + 1 })), { post: true, call: false })
    assert.deepEqual(t('p0', watch(), afk({ lastCall: NOW - CALL_GAP })), { post: true, call: true })
  })
  test('5 replies per thread, then only tracking and calls', () => {
    assert.deepEqual(t('p0', watch(), afk({ replies: { 'C1:5.5': MAX_REPLIES } })), { post: false, call: true })
  })
  test('an outsider never gets a reply, but a p0 still calls', () => {
    assert.deepEqual(t('high', watch({ mentions: 2 }), afk(), true, true), { post: false, call: false })
    assert.deepEqual(t('p0', watch(), afk(), true), { post: false, call: true })
  })
})

describe('noteMention: a burst of messages is one mention', () => {
  test('the second mention counts only after BURST', () => {
    const w = watch({ mentions: 0 })
    assert.equal(noteMention(w, NOW), false)
    assert.equal(noteMention(w, NOW + BURST - 1), false)
    assert.equal(w.mentions, 1)
    assert.equal(noteMention(w, NOW + 2 * BURST), true)
    assert.equal(w.mentions, 2)
  })
})

describe('notePing: one line per thread, kept current', () => {
  test('a later triage of the same thread replaces its line', () => {
    const a = afk()
    notePing(a, ping({ key: 'C1:5.5', note: 'Sam asks about #42' }))
    notePing(a, ping({ key: 'C2:1.1', note: 'Ana says thanks' }))
    notePing(a, ping({ key: 'C1:5.5', note: 'Sam: #42 is now blocking the release', urgency: 'high' }))
    assert.deepEqual(a.pings.map(p => p.note), ['Ana says thanks', 'Sam: #42 is now blocking the release'])
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

describe('parseTriage: what the stand-in wrote', () => {
  test('urgency, note, waits, then the draft reply', () => {
    assert.deepEqual(parseTriage('URGENCY: high\nNOTE: Sam wants #42 reviewed\nWAITS: yes\nREPLY: Maya is away till 6.\nShe will check the PR then.'),
      { urgency: 'high', note: 'Sam wants #42 reviewed', waits: true, reply: 'Maya is away till 6.\nShe will check the PR then.' })
  })
  test('REPLY none means nothing to post', () => {
    assert.deepEqual(parseTriage('URGENCY: low\nNOTE: thanks\nWAITS: no\nREPLY: none'), { urgency: 'low', note: 'thanks', waits: false, reply: '' })
  })
  test('anything else is unusable', () => {
    assert.equal(parseTriage('Sure, here is my reply: hi'), null)
    assert.equal(parseTriage('URGENCY: urgent\nNOTE: x\nWAITS: no\nREPLY: hi'), null)
    assert.equal(parseTriage('URGENCY: low\nNOTE: x\nREPLY: hi'), null)
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
