import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { startAfk } from '../afk.ts'
import type { SlackMessage } from '../../../core/slack-message.ts'
import type { Status } from '../../../core/afk.ts'

const ids = { owner: 'UOWN', bot: 'UBOT', botDm: 'DBOT', name: 'kage', team: 'TTEST' }
const PRIOR: Status = { status_text: 'lunch', status_emoji: ':pizza:' }
const ping = (o: Partial<SlackMessage> = {}) => ({ type: 'message', channel: 'CTEST2', ts: '9.1', user: 'UMATE', client_msg_id: 'x', text: '<@UOWN> prod is down', ...o }) as SlackMessage
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r)) }

function stand(urgency: 'p0' | 'high' | 'normal' | 'low') {
  const sets: Status[] = [], told: string[] = [], calls: string[] = [], judged: string[] = []
  let profile: Status = PRIOR
  let kept: unknown
  const user = {
    users: {
      info: async () => ({ user: { tz: 'UTC' } }),
      profile: { set: async (a: { profile: string }) => { profile = JSON.parse(a.profile); sets.push(profile) }, get: async () => ({ profile }) },
    },
    conversations: { info: async () => ({ channel: { name: 'test' } }) },
    chat: { getPermalink: async () => ({ permalink: '' }), postMessage: async () => assert.fail('an outsider never gets a post') },
  }
  const afk = startAfk({
    dir: '/nonexistent', title: 'Kage', ownerName: 'Ryu', ids, bot: user as never, user: user as never,
    memory: '/nonexistent', model: 'test', saved: { load: () => kept, save: (_: string, v: unknown) => { kept = v } } as never,
    notify: async text => { told.push(text); return true },
    contextOf: async () => '', placeOf: async () => '#test', nameOf: async () => 'Sam',
    call: async reason => { calls.push(reason); return '' },
    jev: async o => { judged.push(o.from); return { urgency, waits: true, lookup: false } },
  })
  return { afk, sets, told, calls, judged }
}

test('AFK sets a status that names the stand-in, and back restores the status the owner had', async () => {
  mock.timers.enable({ apis: ['setInterval', 'Date'], now: Date.UTC(2026, 0, 5, 9) })
  try {
    const s = stand('low')
    assert.match(await s.afk.command({ kind: 'afk', minutes: 60, note: 'offsite' }), /^AFK on until 10:00 am\./)
    assert.equal(s.sets[0]!.status_text, 'Away until 10:00 am. Kage is covering')
    assert.equal(s.sets[0]!.status_emoji, ':ninja:')
    assert.equal(await s.afk.command({ kind: 'back' }), 'Welcome back. Nobody pinged you while you were away.')
    assert.deepEqual(s.sets.at(-1), { ...PRIOR, status_expiration: 0 })
  } finally { mock.timers.reset() }
})

test('a P0 from outside the team phones the owner once per thread and posts nothing there', async () => {
  mock.timers.enable({ apis: ['setInterval', 'Date'], now: Date.UTC(2026, 0, 5, 9) })
  try {
    const s = stand('p0')
    await s.afk.command({ kind: 'afk', minutes: 60, note: '' })
    s.afk.heard(ping())
    await settle()
    s.afk.heard(ping({ ts: '9.2', thread_ts: '9.1', text: '<@UOWN> still down' }))
    await settle()
    assert.deepEqual(s.calls, ['Sam in #test: Sam: <@UOWN> prod is down'])
    assert.equal(s.told.length, 1)
    assert.match(s.told[0]!, /^:rotating_light: P0 from Sam in #test: Sam: <@UOWN> prod is down/)
    assert.match(await s.afk.command({ kind: 'back' }), /Waiting on you \(1\)\*\n• :rotating_light: Sam in #test: Sam: <@UOWN> still down/)
  } finally { mock.timers.reset() }
})

test("the owner's own message in a thread mutes it, so the stand-in judges nothing there after", async () => {
  mock.timers.enable({ apis: ['setInterval', 'Date'], now: Date.UTC(2026, 0, 5, 9) })
  try {
    const s = stand('low')
    await s.afk.command({ kind: 'afk', minutes: 60, note: '' })
    s.afk.heard(ping({ ts: '9.2', thread_ts: '9.1', user: 'UOWN', text: 'on it' }))
    s.afk.heard(ping({ ts: '9.3', thread_ts: '9.1' }))
    await settle()
    assert.deepEqual(s.judged, [])
  } finally { mock.timers.reset() }
})

test('when the time runs out, AFK ends by itself and the owner gets the summary', async () => {
  mock.timers.enable({ apis: ['setInterval', 'Date'], now: Date.UTC(2026, 0, 5, 9) })
  try {
    const s = stand('low')
    await s.afk.command({ kind: 'afk', minutes: 1, note: '' })
    mock.timers.tick(90_000)
    await settle()
    assert.deepEqual(s.told, ['Welcome back. Nobody pinged you while you were away.'])
    assert.deepEqual(s.sets.at(-1), { ...PRIOR, status_expiration: 0 })
  } finally { mock.timers.reset() }
})
