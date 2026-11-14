import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { bearerOk, hourCap, readBody } from '../webhook.ts'

describe('bearerOk', () => {
  test('accepts only the exact "Bearer <token>" header', () => {
    assert.equal(bearerOk('Bearer t0k', 't0k'), true)
    for (const bad of [undefined, '', 't0k', 'Bearer t0', 'Bearer t0kk', 'bearer t0k']) assert.equal(bearerOk(bad, 't0k'), false)
  })
})

describe('hourCap', () => {
  test('is full after perHour adds and frees a slot when the oldest is over an hour old', () => {
    const cap = hourCap(2)
    cap.add(0); cap.add(10)
    assert.equal(cap.full(20), true)
    assert.equal(cap.full(3_600_000), true)    // exactly an hour old still counts
    assert.equal(cap.full(3_600_001), false)   // the first is out, one slot is free
  })
  test('tells once per full spell, and again after a slot is used', () => {
    const cap = hourCap(1)
    cap.add(0)
    assert.equal(cap.tell(), true)
    assert.equal(cap.tell(), false)
    cap.add(1)
    assert.equal(cap.tell(), true)
  })
})

describe('readBody', () => {
  async function run(max: number, body: string) {
    const server = createServer(async (req, res) => {
      const got = await readBody(req, max)
      if (!got) { res.writeHead(413).end(); req.destroy(); return }
      res.writeHead(200).end(got.toString('utf8'))
    })
    await new Promise<void>(ok => server.listen(0, '127.0.0.1', ok))
    const r = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, { method: 'POST', body }).catch(() => undefined)
    server.close(); server.closeAllConnections()
    return r && { status: r.status, text: await r.text().catch(() => '') }
  }
  test('returns the whole body, multi-byte characters intact', async () => {
    assert.deepEqual(await run(100, 'héllo wörld'), { status: 200, text: 'héllo wörld' })
  })
  test('returns nothing above the cap', async () => {
    assert.equal((await run(10, 'x'.repeat(5000)))?.status, 413)
  })
})
