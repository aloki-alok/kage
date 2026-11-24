import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SocketModeClient } from '@slack/socket-mode'
import { connectSlack } from '../connect.ts'
import { listenForCommands } from '../commands.ts'
import { slackHttp, type SlackIntake } from '../http.ts'
import { openStore } from '../../../runtime/store.ts'

const SECRET = 'signing-test-secret'
const TEAM = 'T0TEST1'
const tagged = { type: 'message', channel: 'C0TEST1', ts: '6.6', thread_ts: '6.0', user: 'UTEST1', client_msg_id: 'a', text: '<@UTEST1> check the logs' }

function signedPost(port: number, body: string, o: { type?: string; retry?: number } = {}) {
  const stamp = String(Math.floor(Date.now() / 1000))
  return fetch(`http://127.0.0.1:${port}/slack`, { method: 'POST', body, signal: AbortSignal.timeout(2_500), headers: {
    'content-type': o.type ?? 'application/json', 'x-slack-request-timestamp': stamp,
    'x-slack-signature': `v0=${createHmac('sha256', SECRET).update(`v0:${stamp}:${body}`).digest('hex')}`, ...(o.retry && { 'x-slack-retry-num': String(o.retry) }),
  } })
}

const fakeClient = (history: string[]) => ({
  auth: { test: async () => ({ team_id: TEAM, user_id: 'UTEST1' }) },
  conversations: { open: async () => ({ channel: { id: 'DTEST' } }), history: async (a: { channel: string }) => { history.push(a.channel); return { messages: [] } }, info: async () => ({ channel: { name: 'general' } }),
    replies: async () => ({ messages: [{ user: 'UTEST1', ts: '6.0', text: 'the owner started this thread' }] }) },
  users: { info: async () => ({ user: { real_name: 'Sam Test' } }) },
  chat: { getPermalink: async () => ({ permalink: '' }) },
  reactions: { add: async () => ({ ok: true }), remove: async () => ({ ok: true }) },
})

async function httpSlack() {
  const dir = mkdtempSync(join(tmpdir(), 'kage-slack-http-'))
  const store = openStore(':memory:')
  const tasks: string[] = [], history: string[] = [], caughtUp: unknown[] = []
  const client = fakeClient(history)
  const slack = await connectSlack({
    dir, http: { secret: SECRET, port: 0 }, userToken: 'test', bot: client as never, user: client as never, name: 'kage', title: 'Kage', teammates: [], apps: [],
    hub: { posted: () => '', take: (s: string, c: string, p: string | null) => store.take(s, c, p, Date.now()), handled: (s: string) => store.handled(s), has: (s: string) => store.has(s),
      deliver: (_c: unknown, task: { content: string }) => { tasks.push(task.content); return 'sent' }, channelCatchUp: (h: unknown) => { caughtUp.push(h) } } as never,
  })
  const port = await slack.start() as number
  const close = () => { (slack.transport as ReturnType<typeof slackHttp>).close(); rmSync(dir, { recursive: true, force: true }) }
  return { slack, port, store, tasks, caughtUp, close }
}

const settle = () => new Promise(done => setTimeout(done, 50))

describe('Slack over HTTP feeds the same intake as Socket Mode', () => {
  test('an event Slack sends again, with the same event_id, makes one task, never two', async () => {
    const t = await httpSlack()
    try {
      const body = JSON.stringify({ type: 'event_callback', event_id: 'Ev0TEST1', team_id: TEAM, event: tagged })
      assert.equal((await signedPost(t.port, body)).status, 200)
      assert.equal((await signedPost(t.port, body, { retry: 1 })).status, 200)
      await settle()
      assert.equal(t.tasks.length, 1)
      assert.deepEqual(t.store.unhandled(0), [])
    } finally { t.close() }
  })

  test('catch-up runs when the hub starts in HTTP mode, as it runs at each socket connect', async () => {
    const t = await httpSlack()
    try { assert.equal(t.caughtUp.length, 1) } finally { t.close() }
  })
})

const commandForm = { command: '/nothing', text: '9876543210', user_id: 'U0TEST1', team_id: TEAM, response_url: 'https://hooks.slack.test/r' }

function socketTransport() {
  const socket = new SocketModeClient({ appToken: 'xapp-test' })
  const deliver = (type: string, body: object) => new Promise<unknown>(done => { socket.emit(type, { body, ack: async (response?: unknown) => done(response ?? 'acked') }) })
  return { transport: socket as SlackIntake, deliver }
}

describe('a slash command and a button press reach the same handlers in both modes', () => {
  test('a slash command gets the same answer from listenForCommands over Socket Mode and over HTTP', async () => {
    const commands = new Map([['/truecaller', '/bin/true']])
    const o = { user: fakeClient([]) as never, team: TEAM, commands, ledgers: { add: () => {} } as never }
    const socket = socketTransport()
    listenForCommands(socket.transport, o)
    const overSocket = await socket.deliver('slash_commands', commandForm)
    const http = slackHttp({ secret: SECRET, port: 0 })
    listenForCommands(http, o)
    try {
      const r = await signedPost(await http.start(), new URLSearchParams(commandForm).toString(), { type: 'application/x-www-form-urlencoded' })
      assert.equal(r.status, 200)
      assert.deepEqual(await r.json(), overSocket)
      assert.deepEqual(overSocket, { response_type: 'ephemeral', text: '/nothing is not set up here.' })
    } finally { http.close() }
  })

  test('a button press reaches an interactive listener with the same payload over Socket Mode and over HTTP', async () => {
    const payload = { type: 'block_actions', user: { id: 'U0TEST1' }, actions: [{ action_id: 'approve', value: 'yes' }] }
    const heard: unknown[] = []
    const listen = (t: SlackIntake) => t.on('interactive', async ({ body, ack }: { body: unknown; ack: () => Promise<void> }) => { heard.push(body); await ack() })
    const socket = socketTransport()
    listen(socket.transport)
    await socket.deliver('interactive', payload)
    const http = slackHttp({ secret: SECRET, port: 0 })
    listen(http)
    try {
      const r = await signedPost(await http.start(), new URLSearchParams({ payload: JSON.stringify(payload) }).toString(), { type: 'application/x-www-form-urlencoded' })
      assert.equal(r.status, 200)
      assert.deepEqual(heard, [payload, payload])
    } finally { http.close() }
  })
})
