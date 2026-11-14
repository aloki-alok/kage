import { test } from 'node:test'
import assert from 'node:assert/strict'
import { connectMeeting } from '../meeting.ts'
import { openStore } from '../../runtime/store.ts'

const TOKEN = 'meet-token'
const body = (title = 'Renewal sync') => JSON.stringify({ title, link: 'https://meet.google.com/abc-defg-hij', segments: [{ speaker: 'Jane', text: 'Kim owns the quote.', start: 3 }] })

async function setup(perHour = 100, pollMs = 2000, code?: () => string) {
  const store = openStore(':memory:')
  let clock = Date.now()
  let throwing = false
  const posts: string[] = []
  const tasks: { key: string; content: string; fromOwner: boolean; channel?: string }[] = []
  const told: string[] = []
  let ts = 100
  const ended: string[] = []
  const m = connectMeeting({
    token: TOKEN, port: 0, botDm: 'DB', perHour, pollMs, name: 'kage', askWaitMs: 50, end: key => void ended.push(key), notify: t => void told.push(t), now: () => clock,
    untake: s => store.untake(s), code,
    inbox: { take: (s, c, p) => store.take(s, c, p, Date.now()), handled: s => store.handled(s), has: s => store.has(s) },
    post: async text => { posts.push(text); return String(ts++) },
    deliver: (c, task) => { if (throwing) throw new Error('runner down'); tasks.push({ key: c.connector === 'voice' ? `voice:${c.chat}` : `${c.chat}:${c.thread}`, content: task.content, fromOwner: task.fromOwner, channel: task.meta.channel }); return 'sent' },
  })
  const port = await m.listening
  const send = (b: string, auth = `Bearer ${TOKEN}`) => fetch(`http://127.0.0.1:${port}/meeting`, { method: 'POST', body: b, headers: { authorization: auth, 'content-type': 'application/json' } })
  const bot = (path: string, init: RequestInit = {}, auth = `Bearer ${TOKEN}`) =>
    fetch(`http://127.0.0.1:${port}${path}`, { ...init, headers: { authorization: auth, 'content-type': 'application/json' } })
  return { m, store, posts, tasks, told, send, bot, ended, later: (ms: number) => { clock += ms }, throwOnDeliver: (on = true) => { throwing = on } }
}

test('a transcript opens one DM thread per meeting and runs at teammate trust', async () => {
  const t = await setup()
  try {
    assert.equal((await t.send(body('A'))).status, 202)
    assert.equal((await t.send(body('B'))).status, 202)
    assert.deepEqual(t.tasks.map(x => x.key), ['DB:100', 'DB:101'])
    assert.equal(t.tasks[0]!.fromOwner, false)
    assert.match(t.posts[0]!, /Meeting:\* A <https:\/\/meet\.google\.com\/abc-defg-hij\|open>/)
    assert.match(t.tasks[0]!.content, /> \[00:03\] Jane: Kim owns the quote\./)
  } finally { t.m.close() }
})

test('a wrong or missing token, a wrong path and a body with no speech start nothing', async () => {
  const t = await setup()
  try {
    assert.equal((await t.send(body(), 'Bearer nope')).status, 401)
    assert.equal((await t.send(body(), '')).status, 401)
    const port = await t.m.listening
    assert.equal((await fetch(`http://127.0.0.1:${port}/other`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}` } })).status, 404)
    assert.equal((await t.send('{"segments":[]}')).status, 400)
    assert.equal((await t.send('not json')).status, 400)
    assert.equal(t.tasks.length, 0)
  } finally { t.m.close() }
})

test('the same transcript sent twice runs once', async () => {
  const t = await setup()
  try {
    await t.send(body())
    assert.equal((await t.send(body())).status, 202)
    assert.equal(t.tasks.length, 1)
  } finally { t.m.close() }
})

test('past the hourly cap the owner gets one note and the rest are skipped', async () => {
  const t = await setup(1)
  try {
    await t.send(body('A')); await t.send(body('B')); await t.send(body('C'))
    assert.equal(t.tasks.length, 1)
    assert.equal(t.told.length, 1)
  } finally { t.m.close() }
})

test('a transcript the hub took but never handled replays from the inbox', async () => {
  const t = await setup()
  try {
    const b = body('Lost')
    t.store.take('meeting:x', 'meeting', b, Date.now())
    await t.m.replay('meeting:x', b)
    assert.equal(t.tasks.length, 1)
    assert.equal(t.store.unhandled(0).length, 0)   // marked handled, so the next start does not run it again
  } finally { t.m.close() }
})

test('a transcript that failed, or was skipped for the cap, runs when it is sent again', async () => {
  const t = await setup(1)
  try {
    t.throwOnDeliver()
    assert.equal((await t.send(body('A'))).status, 500)
    t.throwOnDeliver(false)
    assert.equal((await t.send(body('A'))).status, 202)
    assert.equal(t.tasks.length, 1)
    assert.equal((await t.send(body('B'))).status, 202)   // over the cap: skipped, the owner is told
    assert.equal(t.tasks.length, 1)
    t.later(3600_001)
    await t.send(body('B'))
    assert.equal(t.tasks.length, 2)
  } finally { t.m.close() }
})

test('a body with nothing to take notes on is refused every time it comes', async () => {
  const t = await setup()
  try {
    assert.equal((await t.send('{"segments":[]}')).status, 400)
    assert.equal((await t.send('{"segments":[]}')).status, 400)
  } finally { t.m.close() }
})

test('the title in the Slack post cannot ping the channel or forge a link', async () => {
  const t = await setup()
  try {
    await t.send(body('<!channel> <https://evil|ok>'))
    assert.doesNotMatch(t.posts[0]!, /<!channel>|<https:\/\/evil/)
  } finally { t.m.close() }
})

// The meeting bot (#63): it long-polls for commands and posts caption lines on the same port and token.
test('a join waits until the bot polls, then reaches it once; a poll after it gets only newer commands', async () => {
  const t = await setup(100, 300)
  try {
    assert.match(t.m.join('https://meet.google.com/abc-defg-hij'), /not connected/)
    assert.equal((await t.bot('/meetbot/next?after=0')).status, 204)   // nothing to do: the poll ends empty
    const held = t.bot('/meetbot/next?after=0')
    await new Promise(r => setTimeout(r, 50))
    assert.equal(t.m.join('meet.google.com/abc-defg-hij?authuser=0'), '')
    const r = await held
    assert.equal(r.status, 200)
    const cmds = await r.json() as { seq: number; op: string; link: string }[]
    assert.deepEqual(cmds.map(c => [c.op, c.link]), [['join', 'https://meet.google.com/abc-defg-hij']])
    assert.equal((await t.bot(`/meetbot/next?after=${cmds[0]!.seq}`)).status, 204)
    // A bot that lost the answer polls again from its old place and gets the command again.
    assert.equal((await t.bot('/meetbot/next?after=0')).status, 200)
    // A join this old is for a call long gone: a restarted bot polling from 0 must not walk into the next meeting on that code.
    t.later(5 * 60_000 + 1)
    assert.equal((await t.bot('/meetbot/next?after=0')).status, 204)
  } finally { t.m.close() }
})

test('each join carries a fresh owner code for the voice agent, so the call reaches Kage as the owner', async () => {
  let n = 0
  const t = await setup(100, 300, () => `code-${++n}`)
  try {
    const held = t.bot('/meetbot/next?after=0')
    await new Promise(r => setTimeout(r, 50))
    assert.equal(t.m.join('https://meet.google.com/abc-defg-hij'), '')
    const [first] = await (await held).json() as { seq: number; code?: string }[]
    assert.equal(first!.code, 'code-1')
    const next = t.bot(`/meetbot/next?after=${first!.seq}`)
    await new Promise(r => setTimeout(r, 50))
    assert.equal(t.m.join('https://meet.google.com/abc-defg-hij'), '')
    assert.equal(((await (await next).json()) as { code?: string }[])[0]!.code, 'code-2')
  } finally { t.m.close() }
})

test('a join is refused for anything but a Meet link, and nothing is queued', async () => {
  const t = await setup(100, 100)
  try {
    await t.bot('/meetbot/next?after=0')
    assert.match(t.m.join('https://evil.example/abc-defg-hij'), /not a Google Meet link/)
    assert.equal((await t.bot('/meetbot/next?after=0')).status, 204)
  } finally { t.m.close() }
})

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const lines = (...l: [string, string][]) => JSON.stringify({ call: 'abc-defg-hij', segments: l.map(([speaker, text]) => ({ speaker, text })) })

test('a line that names Kage starts one voice-limited session for the call; other lines only add context', async () => {
  const t = await setup()
  try {
    const post = (b: string, auth?: string) => t.bot('/meetbot/segments', { method: 'POST', body: b }, auth)
    assert.equal((await post(lines(['Kim', 'I own the deploy.']))).status, 200)
    assert.equal(t.tasks.length, 0)
    assert.equal((await post(lines(['Jane', 'Kage, who owns the deploy?']))).status, 200)
    await sleep(120)
    assert.equal(t.tasks.length, 1)
    const task = t.tasks[0]!
    assert.deepEqual([task.key, task.fromOwner, task.channel], ['voice:meet-abc-defg-hij', false, 'voice'])
    assert.match(task.content, /^Voice task \(a caller, not the owner/)
    assert.match(task.content, /^> Kim: I own the deploy\.$/m)
    // While that question waits, another one is not started on top of it.
    await post(lines(['Jane', 'Kage, are you there?']))
    await sleep(120)
    assert.equal(t.tasks.length, 1)
    assert.equal((await post(lines(['Jane', 'x']), 'Bearer nope')).status, 401)
    assert.equal((await post('{"segments":[]}')).status, 400)
  } finally { t.m.close() }
})

test("the session's reply reaches the bot as a say command for its call, and the next question may start", async () => {
  const t = await setup()
  try {
    await t.bot('/meetbot/next?after=0')
    await t.bot('/meetbot/segments', { method: 'POST', body: lines(['Jane', 'Kage, ping']) })
    await sleep(120)
    assert.equal(t.m.say('voice:meet-abc-defg-hij', 'Pong.'), true)
    const r = await t.bot('/meetbot/next?after=0')
    assert.deepEqual((await r.json() as { op: string; call: string; text: string }[]).map(c => [c.op, c.call, c.text]), [['say', 'abc-defg-hij', 'Pong.']])
    assert.equal(t.m.say('voice:some-phone-call', 'x'), false)   // not a meeting: the phone connector's
    await t.bot('/meetbot/segments', { method: 'POST', body: lines(['Jane', 'Kage, again']) })
    await sleep(120)
    assert.equal(t.tasks.length, 2)
  } finally { t.m.close() }
})

test('when the bot says the call ended, its live session ends and a new question starts fresh', async () => {
  const t = await setup()
  try {
    await t.bot('/meetbot/segments', { method: 'POST', body: lines(['Jane', 'Kage, ping']) })
    await sleep(120)
    assert.equal((await t.bot('/meetbot/ended', { method: 'POST', body: '{"call":"abc-defg-hij"}' })).status, 200)
    assert.deepEqual(t.ended, ['voice:meet-abc-defg-hij'])
    assert.equal((await t.bot('/meetbot/ended', { method: 'POST', body: '{"call":"../x"}' })).status, 400)
    await t.bot('/meetbot/segments', { method: 'POST', body: lines(['Jane', 'Kage, again']) })
    await sleep(120)
    assert.equal(t.tasks.length, 2)   // the old question no longer blocks
  } finally { t.m.close() }
})

test('a question split across caption lines is asked once, whole, and its later rewrite is not asked again', async () => {
  const t = await setup()
  try {
    const post = (...l: [string, string][]) => t.bot('/meetbot/segments', { method: 'POST', body: lines(...l) })
    await post(['Jane', 'Kage, what is'])
    await sleep(20)
    await post(['Kim', 'hm'], ['Jane', 'the status of the launch'])
    assert.equal(t.tasks.length, 0)   // still listening for the rest of the question
    await sleep(120)
    assert.equal(t.tasks.length, 1)
    assert.match(t.tasks[0]!.content, /"Kage, what is the status of the launch"/)
    t.m.say('voice:meet-abc-defg-hij', 'On track.')
    // Meet rewrites the caption block, so the bot sends the whole line again: the same question, already answered.
    await post(['Jane', 'Kage, what is the status of the launch?'])
    await sleep(120)
    assert.equal(t.tasks.length, 1)
    await post(['Jane', 'Kage, and the budget?'])
    await sleep(120)
    assert.equal(t.tasks.length, 2)
  } finally { t.m.close() }
})
