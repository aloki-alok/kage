import { test, mock, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startWhatsApp } from '../whatsapp.ts'

const dir = mkdtempSync(join(tmpdir(), 'kage-wa-'))
after(() => rmSync(dir, { recursive: true, force: true }))
const ME = '15550000001@c.us', FRIEND = '15550000002@c.us'
let port = 41000 + Math.floor(Math.random() * 2000)

function wa() {
  const calls: string[] = [], tasks: { chat: string; content: string; source?: string }[] = [], told: string[] = [], answers: unknown[] = [], handled: string[] = []
  mock.method(globalThis, 'fetch', async (url: string) => {
    const path = String(url).replace('http://waha.test.invalid', '')
    calls.push(path)
    if (path.startsWith('/api/sessions/default/me')) return Response.json({ id: ME })
    if (path.includes('/messages')) return Response.json([{ fromMe: false, body: 'are we still on for friday' }])
    return Response.json({})
  })
  const w = startWhatsApp({
    dir, name: 'kage', owner: 'Ryu', memory: join(dir, 'memory'),
    waha: { WHATSAPP_HOOK_HMAC_KEY: 'test-hmac', WAHA_API_KEY: 'test-key' },
    whatsapp: { wahaUrl: 'http://waha.test.invalid', hookPort: port++ },
    inbox: { handled: (s: string) => void handled.push(s) } as never,
    onTask: t => void tasks.push(t), notify: t => void told.push(t),
    ownerAnswer: a => void answers.push(a),
  })
  after(() => w.close())
  return { w, calls, tasks, told, answers, handled }
}

const msg = (o: Record<string, unknown>) => JSON.stringify({ from: FRIEND, id: 'm1', fromMe: true, body: '@kage book it', ...o })

test("the owner's tag in a chat becomes one task that quotes the chat, and its source is marked handled", async () => {
  const s = wa()
  await s.w.replay('wa:m1', msg({}))
  assert.equal(s.tasks.length, 1)
  assert.equal(s.tasks[0]!.chat, FRIEND)
  assert.equal(s.tasks[0]!.source, 'wa:m1')
  assert.match(s.tasks[0]!.content, /^WhatsApp task from Ryu \(their own message in WhatsApp chat [^)]+\): book it$/m)
  assert.match(s.tasks[0]!.content, /^> \[them\] are we still on for friday$/m)
  assert.deepEqual(s.handled, ['wa:m1'])
})

test('a message from someone else in a chat no one armed starts nothing', async () => {
  const s = wa()
  await s.w.replay('wa:m2', msg({ fromMe: false, body: 'hi' }))
  assert.equal(s.tasks.length, 0)
  assert.deepEqual(s.handled, ['wa:m2'])
})

test("the owner's yes with a code in their own chat answers a card, but never on a replay", async () => {
  const s = wa()
  await s.w.replay('wa:m3', msg({ from: ME, body: 'yes 1234' }))
  assert.deepEqual(s.answers, [])
  assert.equal(s.tasks.length, 0)
})

test('a reply that carries a secret is held for the owner and never reaches WAHA', async () => {
  const s = wa()
  await s.w.send(`wa:${FRIEND}`, 'the key is AKIAABCDEFGHIJKLMNOP')
  assert.equal(s.told.length, 1)
  assert.match(s.told[0]!, /looks like a key or secret/)
  assert.equal(s.calls.filter(c => c === '/api/sendText').length, 0)
})
