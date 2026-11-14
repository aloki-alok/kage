// Real Chromium and the real bot/bridge, with a local Meet page and a local voice agent.
import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { once } from 'node:events'
import { chromium } from 'playwright-core'
import { WebSocketServer, type WebSocket } from 'ws'
import { attend, PAGE_JS } from '../bot.ts'
import { bridge } from '../voice-agent.ts'

const FAKE = readFileSync(new URL('./fake-meet.html', import.meta.url), 'utf8')
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const until = async (ok: () => boolean, message: string) => {
  for (let i = 0; i < 100 && !ok(); i++) await sleep(20)
  assert.ok(ok(), message)
}

// Raw 16 kHz PCM16, as the voice agent sends it (no WAV header).
function tone(seconds: number) {
  const pcm = Buffer.alloc(16000 * seconds * 2)
  for (let i = 0; i < pcm.length / 2; i++) pcm.writeInt16LE(Math.round(12000 * Math.sin(2 * Math.PI * 440 * i / 16000)), i * 2)
  return pcm.toString('base64')
}

async function setup(t: TestContext, ownerCode?: string) {
  const creates: { agent_id?: number; custom_variables?: { owner_code?: string } }[] = []
  const audio: { type?: string; data?: string }[] = []
  let socket: WebSocket | undefined
  const server = createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/api/v1/sessions/create') {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk)
      creates.push(JSON.parse(Buffer.concat(chunks).toString()))
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ws_url: `ws://127.0.0.1:${port}/voice` }))
    } else if (req.url === '/meet') res.writeHead(200, { 'content-type': 'text/html' }).end(FAKE)
    else res.writeHead(404).end()
  })
  const sockets = new WebSocketServer({ server, path: '/voice' })
  sockets.on('connection', ws => {
    socket = ws
    ws.on('message', data => audio.push(JSON.parse(String(data))))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = (server.address() as AddressInfo).port
  t.after(async () => {
    for (const ws of sockets.clients) ws.terminate()
    await new Promise<void>(resolve => sockets.close(() => resolve()))
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  })
  const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] })
  t.after(() => browser.close())
  const ctx = await browser.newContext()
  await ctx.addInitScript({ path: PAGE_JS })
  const page = await ctx.newPage()
  page.setDefaultTimeout(5000)
  const logs: string[] = []
  let stop = false, finished = false
  const done = attend(page, `http://127.0.0.1:${port}/meet`, {
    name: 'Kage (test)', consent: 'Test call.', heard: () => {}, stop: () => stop,
    voice: (pg, ended) => bridge(pg, { api: `http://127.0.0.1:${port}`, key: 'test-key', agent: 42, ownerCode }, (...a) => logs.push(a.join(' ')), ended),
  }).finally(() => { finished = true })
  // Observe failures at once, including when an assertion exits before attend finishes.
  void done.catch(() => {})
  t.after(async () => { stop = true; await done.catch(() => {}) })
  await page.waitForFunction(() => document.querySelector('#waiting:not(.hide)'))
  // A remote participant's audio track, separate from the mic Meet gets from getUserMedia.
  await page.evaluate(() => {
    const ac = new AudioContext(), oscillator = ac.createOscillator(), out = ac.createMediaStreamDestination()
    oscillator.frequency.value = 440
    oscillator.connect(out)
    oscillator.start()
    const el = document.createElement('audio')
    el.srcObject = out.stream
    document.body.append(el)
    void ac.resume()
    ;(window as any).fake.admit()
  })
  await page.waitForFunction(() => (window as any).fake.sent.length === 1)
  await until(() => !!socket, 'the bot connected to the fake voice agent')
  const send = (event: string, payload?: string) => socket!.send(JSON.stringify({ event, ...(payload && { media: { payload } }) }))
  return { page, creates, audio, send, socket: () => socket!, logs, done, finished: () => finished }
}

test('the voice session create body carries the agent and owner code', { timeout: 15_000 }, async t => {
  const s = await setup(t, 'test-owner-code')
  assert.equal(s.creates.length, 1)
  assert.equal(s.creates[0]!.agent_id, 42)
  assert.equal(s.creates[0]!.custom_variables?.owner_code, 'test-owner-code')
})

test('audio from the Meet page reaches the voice socket as audio frames', { timeout: 15_000 }, async t => {
  const s = await setup(t)
  await until(() => s.audio.some(frame => {
    if (frame.type !== 'audio' || typeof frame.data !== 'string') return false
    const pcm = Buffer.from(frame.data, 'base64')
    if (pcm.length !== 4096) return false
    for (let i = 0; i < pcm.length; i += 2) if (Math.abs(pcm.readInt16LE(i)) > 1000) return true
    return false
  }), 'the socket received PCM16 audio containing the page tone')
})

test('media frames play into the microphone Meet receives', { timeout: 15_000 }, async t => {
  const s = await setup(t)
  assert.equal(await s.page.evaluate(() => (window as any).fake.peak), 0)
  s.send('media', tone(2))
  await s.page.waitForFunction(() => (window as any).fake.peak > 0.2)
})

test('clear stops both current and queued microphone playback', { timeout: 15_000 }, async t => {
  const s = await setup(t)
  s.send('media', tone(1))
  s.send('media', tone(1))
  await s.page.waitForFunction(() => (window as any).fake.peak > 0.2)
  s.send('clear')
  // Let the analyser's existing sample window drain, then measure a fresh interval.
  await sleep(200)
  await s.page.evaluate(() => { (window as any).fake.peak = 0 })
  await sleep(1200)
  assert.ok(await s.page.evaluate(() => (window as any).fake.peak < 0.01), 'Meet hears silence after clear')
  // A later frame must start at once, rather than waiting behind the cleared queue.
  s.send('media', tone(1))
  await s.page.waitForFunction(() => (window as any).fake.peak > 0.2)
})

test('end_call makes the bot click Leave and finish the call', { timeout: 15_000 }, async t => {
  const s = await setup(t)
  s.send('end_call')
  await s.page.waitForFunction(() => document.querySelector('#ended:not(.hide)'))
  await until(s.finished, 'attend finished after the agent hung up')
  await s.done
})

test("the log names each voice agent event but never a caller's words (ADR 0010)", { timeout: 15_000 }, async t => {
  const s = await setup(t)
  s.send('user', 'my card number is secret-words')
  s.socket().send(JSON.stringify({ event: 'partial_text', text: 'more secret-words' }))
  await until(() => s.logs.some(l => l.includes('partial_text')), 'the unknown event is logged by its type')
  assert.ok(s.logs.every(l => !l.includes('secret-words')), s.logs.join('\n'))
})
