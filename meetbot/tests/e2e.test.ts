// The bot in real Chromium against a fake Meet page (fake-meet.html), posting to the real hub connector.
// Run from meetbot/: node --test tests/e2e.test.ts (needs `npx playwright-core install chromium` once).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { chromium } from 'playwright-core'
import { attend, callId, hub, PAGE_JS, type Seg } from '../bot.ts'
import { connectMeeting } from '../../connectors/meeting.ts'

const TOKEN = 'test-meeting-token'
const LINK = 'https://meet.google.com/abc-defg-hij'
const FAKE = readFileSync(new URL('./fake-meet.html', import.meta.url), 'utf8')
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

async function setup() {
  const heard: { call: string; lines: { speaker: string; text: string }[] }[] = []
  const m = connectMeeting({
    token: TOKEN, port: 0, botDm: 'DTEST', perHour: 10, pollMs: 1000, notify: () => {}, untake: () => {},
    inbox: { take: () => true, handled: () => {}, has: () => false },
    post: async () => '1.1', deliver: () => 'sent', onLines: (call, lines) => void heard.push({ call, lines }),
  })
  const h = hub({ hub: `http://127.0.0.1:${await m.listening}`, token: TOKEN })
  const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] })
  const ctx = await browser.newContext()
  await ctx.addInitScript({ path: PAGE_JS })
  await ctx.route('https://meet.google.com/**', r => r.fulfill({ contentType: 'text/html', body: FAKE }))
  const page = await ctx.newPage()
  return { m, h, page, heard, close: async () => { await browser.close(); m.close() } }
}

test('the bot takes a join from the hub, joins, posts the consent line, and streams settled captions', async () => {
  const t = await setup()
  try {
    // The hub queues a join only once the bot has polled; the bot then reads it on its next poll.
    await t.h.next(0)
    assert.equal(t.m.join(LINK), '')
    const [cmd] = await t.h.next(0)
    assert.deepEqual([cmd!.op, cmd!.link], ['join', LINK])

    const done = attend(t.page, cmd!.link, {
      name: 'Kage (notes)', consent: 'Kage is taking notes.', aloneMs: 60_000,
      heard: segs => t.h.lines(callId(cmd!.link), segs),
    })
    await t.page.waitForFunction(() => (window as any).fake?.mic !== null && document.querySelector('#waiting:not(.hide)'))
    await t.page.evaluate(() => (window as any).fake.admit())
    await t.page.waitForFunction(() => (window as any).fake.captions && (window as any).fake.sent.length)
    assert.deepEqual(await t.page.evaluate(() => [(window as any).fake.name, (window as any).fake.sent, (window as any).fake.mic]),
      ['Kage (notes)', ['Kage is taking notes.'], 1])

    // A block that grows, then holds still, goes out once; its later growth goes out as the new part only.
    await t.page.evaluate(() => (window as any).fake.say('Jane', 'Kage, what', 'b1'))
    await sleep(400)
    await t.page.evaluate(() => (window as any).fake.say('Jane', 'Kage, what is next?', 'b1'))
    await sleep(2500)
    await t.page.evaluate(() => (window as any).fake.say('Jane', 'Kage, what is next? The deploy.', 'b1'))
    await t.page.evaluate(() => (window as any).fake.say('Kim', 'I own it.'))
    await sleep(2500)
    await t.page.evaluate(() => (window as any).fake.end())
    const all: Seg[] = await done
    assert.deepEqual(all.map(s => `${s.speaker}: ${s.text}`), ['Jane: Kage, what is next?', 'Jane: The deploy.', 'Kim: I own it.'])
    assert.deepEqual(t.heard.flatMap(x => x.lines.map(l => `${x.call} ${l.speaker}: ${l.text}`)),
      ['abc-defg-hij Jane: Kage, what is next?', 'abc-defg-hij Jane: The deploy.', 'abc-defg-hij Kim: I own it.'])
  } finally { await t.close() }
})

test('the bot leaves a call once it is alone, and gives up when Meet refuses it', async () => {
  const t = await setup()
  try {
    const done = attend(t.page, LINK, { name: 'Kage (notes)', consent: 'hi', aloneMs: 1500, heard: () => {} })
    await t.page.waitForFunction(() => document.querySelector('#waiting:not(.hide)'))
    await t.page.evaluate(() => { (window as any).fake.admit(); (window as any).fake.alone() })
    await done
    assert.equal(await t.page.evaluate(() => !document.querySelector('#ended')!.classList.contains('hide')), true)   // it clicked Leave call

    const page = await t.page.context().newPage()
    const refused = attend(page, LINK, { name: 'Kage (notes)', consent: 'hi', heard: () => {} })
    await page.waitForFunction(() => document.querySelector('#waiting:not(.hide)'))
    await page.evaluate(() => { document.body.append("You can't join this video call") })
    await assert.rejects(refused, /did not let Kage in \(refused\)/)
  } finally { await t.close() }
})
