import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pruneMissed, webhook } from '../server.ts'
import type { MetaEvent } from '../meta.ts'

async function up(got: MetaEvent[][]): Promise<{ url: string; server: Server }> {
  const server = createServer(webhook({ verifyToken: 'vt', appSecret: 'app-secret', onEvents: e => got.push(e) }))
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server }
}
const sign = (b: string) => `sha256=${createHmac('sha256', 'app-secret').update(b).digest('hex')}`
const body = JSON.stringify({ object: 'page', entry: [{ id: 'P1', messaging: [{ sender: { id: 'U1' }, recipient: { id: 'P1' }, timestamp: 1, message: { mid: 'm1', text: 'hi' } }] }] })

describe('the webhook', () => {
  test("Meta's handshake answers only the right verify token", async () => {
    const { url, server } = await up([])
    const ok = await fetch(`${url}/webhook?hub.mode=subscribe&hub.verify_token=vt&hub.challenge=123`)
    assert.equal(ok.status, 200)
    assert.equal(await ok.text(), '123')
    assert.equal((await fetch(`${url}/webhook?hub.mode=subscribe&hub.verify_token=no&hub.challenge=123`)).status, 403)
    server.close()
  })

  test('only a body signed with the app secret is read', async () => {
    const got: MetaEvent[][] = []
    const { url, server } = await up(got)
    const post = (sig?: string) => fetch(`${url}/webhook`, { method: 'POST', body, headers: sig ? { 'x-hub-signature-256': sig } : {} })
    assert.equal((await post()).status, 401)
    assert.equal((await post('sha256=00')).status, 401)
    assert.equal((await post(sign(body + ' '))).status, 401)
    assert.equal(got.length, 0)
    assert.equal((await post(sign(body))).status, 200)
    assert.equal(got.length, 1)
    assert.equal(got[0]![0]!.kind === 'message' && got[0]![0]!.text, 'hi')
    server.close()
  })

  test('other paths and methods are refused', async () => {
    const { url, server } = await up([])
    assert.equal((await fetch(`${url}/other`)).status, 404)
    assert.equal((await fetch(`${url}/webhook`, { method: 'PUT' })).status, 405)
    assert.equal((await fetch(`${url}/health`)).status, 200)
    server.close()
  })
})

describe('the missed questions file', () => {
  test('keeps the question text only as long as the chat lines', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'metabot-')), 'missed.jsonl')
    const line = (at: string, question: string) => `${JSON.stringify({ at, question })}\n`
    writeFileSync(file, line('2026-10-01T00:00:00.000Z', 'old') + '{"at":"2026-11-19T0\n' + line('2026-11-19T00:00:00.000Z', 'new'))
    pruneMissed(file, Date.parse('2026-11-01T00:00:00.000Z'))
    assert.equal(readFileSync(file, 'utf8'), line('2026-11-19T00:00:00.000Z', 'new'))
    assert.equal(statSync(file).mode & 0o777, 0o600)
  })

  test('a missing file is fine', () => {
    pruneMissed(join(mkdtempSync(join(tmpdir(), 'metabot-')), 'missed.jsonl'), Date.now())
  })
})
