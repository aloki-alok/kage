import { test } from 'node:test'
import assert from 'node:assert/strict'
import { connectMeeting } from './meeting.ts'
import { openStore } from '../runtime/store.ts'

const TOKEN = 'meet-token'
const body = (title = 'Renewal sync') => JSON.stringify({ title, link: 'https://meet.google.com/abc-defg-hij', segments: [{ speaker: 'Jane', text: 'Kim owns the quote.', start: 3 }] })

async function setup(perHour = 100) {
  const store = openStore(':memory:')
  const posts: string[] = []
  const tasks: { key: string; content: string; fromOwner: boolean }[] = []
  const told: string[] = []
  let ts = 100
  const m = connectMeeting({
    token: TOKEN, port: 0, botDm: 'DB', perHour, notify: t => void told.push(t),
    inbox: { take: (s, c, p) => store.take(s, c, p, Date.now()), handled: s => store.handled(s), has: s => store.has(s) },
    post: async text => { posts.push(text); return String(ts++) },
    deliver: (c, task) => { tasks.push({ key: `${c.chat}:${c.thread}`, content: task.content, fromOwner: task.fromOwner }); return 'sent' },
  })
  const port = await m.listening
  const send = (b: string, auth = `Bearer ${TOKEN}`) => fetch(`http://127.0.0.1:${port}/meeting`, { method: 'POST', body: b, headers: { authorization: auth, 'content-type': 'application/json' } })
  return { m, store, posts, tasks, told, send }
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
