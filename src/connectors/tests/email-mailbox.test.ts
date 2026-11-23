import { test, mock, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SQSClient } from '@aws-sdk/client-sqs'
import { S3Client } from '@aws-sdk/client-s3'
import { SESv2Client } from '@aws-sdk/client-sesv2'
import { connectEmail } from '../email.ts'

const SELF = 'kage@example.com', OWNER = 'owner@example.com'
const parked = new Promise<never>(() => {})
const settle = async () => { for (let i = 0; i < 30; i++) await new Promise(r => setImmediate(r)) }
const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

function mailbox(o: { messages?: string[]; threads?: Record<string, unknown> } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'kage-mail-'))
  dirs.push(dir)
  const fetched: string[] = [], deleted: string[] = [], taken: string[] = [], sent: string[] = [], delivered: unknown[] = []
  const waiting = [...(o.messages ?? [])]
  mock.method(SQSClient.prototype, 'send', async (cmd: { constructor: { name: string }; input: { ReceiptHandle?: string } }) => {
    if (cmd.constructor.name === 'DeleteMessageCommand') { deleted.push(cmd.input.ReceiptHandle!); return {} }
    const next = waiting.shift()
    return next === undefined ? parked : { Messages: [{ Body: next, ReceiptHandle: `r${deleted.length + 1}` }] }
  })
  mock.method(S3Client.prototype, 'send', async (cmd: { input: { Key: string } }) => (fetched.push(cmd.input.Key), { Body: { transformToByteArray: async () => Buffer.from(cmd.input.Key) } }))
  mock.method(SESv2Client.prototype, 'send', async (cmd: { input: { Content: { Raw: { Data: Uint8Array } } } }) => { sent.push(Buffer.from(cmd.input.Content.Raw.Data).toString('utf8')); return {} })
  const seen = new Set<string>()
  const email = connectEmail({
    mail: { queue: 'https://sqs.test.invalid/q', address: SELF, ownerEmail: OWNER, accessKeyId: 'test', secretAccessKey: 'test' },
    saved: { load: (k: string) => k === 'mail-threads' ? o.threads : undefined, save: () => {} } as never,
    name: 'kage', nameOf: async id => id, dir, notify: () => {},
    deliver: (_c, task) => { delivered.push(task); return 'sent' }, failed: () => {},
    inbox: { has: (s: string) => seen.has(s), take: (s: string) => { taken.push(s); seen.add(s); return true }, handled: () => {} } as never,
  })
  return { email: email!, fetched, deleted, taken, sent, delivered }
}

const received = (raw: string) => JSON.stringify({ notificationType: 'Received', mail: { messageId: 'ses-1' }, receipt: { action: { bucketName: 'b', objectKey: raw } } })
const unsigned = `From: ${OWNER}\r\nTo: ${SELF}\r\nSubject: Hi\r\nMessage-ID: <m1@example.com>\r\n\r\nplease look\r\n`

test('an unsigned mail is recorded once and dropped, and every queue message is deleted, even one that fails', async () => {
  const m = mailbox({ messages: [received(unsigned), received(unsigned), JSON.stringify({ notificationType: 'Bounce' }), 'not json'] })
  await settle()
  await new Promise(r => setTimeout(r, 200))
  assert.deepEqual(m.taken, ['mail:<m1@example.com>'])
  assert.deepEqual(m.deleted, ['r1', 'r2', 'r3', 'r4'])
  assert.equal(m.fetched.length, 2)
  assert.equal(m.delivered.length, 0)
})

test('a reply inside the owner domain goes out as a reply on the thread, and an unknown thread is refused', async () => {
  const mail = { verdicts: {}, dkim: [], from: OWNER, to: [SELF], cc: [], messageId: '<m1@example.com>', references: [], subject: 'Hi', text: 'please look' }
  const m = mailbox({ threads: { 'mail:t1': { mail } } })
  await m.email.send('mail:t1', 'Done, it is fixed.')
  assert.equal(m.sent.length, 1)
  assert.match(m.sent[0]!, /^In-Reply-To: <m1@example\.com>$/m)
  assert.match(m.sent[0]!, /^Subject: Re: Hi$/m)
  assert.match(m.sent[0]!, /^To: owner@example\.com$/m)
  await assert.rejects(m.email.send('mail:nope', 'x'), /no mail thread mail:nope/)
})
