import { test } from 'node:test'
import assert from 'node:assert/strict'
import { connectorHealth } from '../connector-health.ts'

const MIN = 60_000, start = Date.parse('2026-11-22T08:00:00Z')
const started = (...names: string[]) => { const h = connectorHealth(start); for (const n of names) h.see([n === 'jev' ? 'jev checks every listed agent at threshold 0.5' : `${n} on: 127.0.0.1:1`], start); return h }

test('each connector gets one line: on or off, when it last heard something, and its failures in the past hour (#256)', () => {
  const h = started('email', 'whatsapp', 'voice')
  h.see(['whatsapp task in', 'ab12cd34'], start + 1 * MIN)
  h.see(['mail task,', 'owner', 'ab12'], start + 3 * MIN)
  for (const m of [10, 20, 30]) h.see(['mail poll failed', new Error('ExpiredToken: the token expired')], start + m * MIN)
  assert.deepEqual(h.lines(start + 35 * MIN), [
    'email     on · last heard 32m ago · failed 3x in 1h: mail poll failed: ExpiredToken: the token expired',
    'whatsapp  on · last heard 34m ago',
    'voice     on · nothing heard since the hub started 35m ago',
    'meetings  off',
    'github    off',
    'sms       off',
    'jev       off',
  ])
})

test('a failure older than an hour drops off the line, and a start line is not an event', () => {
  const h = started('voice')
  h.see(['voice request failed', new Error('boom')], start + MIN)
  assert.equal(h.lines(start + 62 * MIN)[2], 'voice     on · nothing heard since the hub started 1h ago')
})

test('a connector whose port is taken shows off', () => {
  const h = started('voice')
  h.see(['voice could not listen', new Error('EADDRINUSE')], start + MIN)
  assert.equal(h.lines(start + 2 * MIN)[2], 'voice     off')
})

test('Jev shows its calls and failures since midnight, and a skipped triage is not a call', () => {
  const h = started('jev')
  h.see(['triage C1:5.5: session: no jev call, in a thread, reaction none 0.00, 1 ms'], start + MIN)
  h.see(['triage C1:5.5: react: owner react 0.96, reaction thumbsup 0.90, 300 ms'], start + 2 * MIN)
  h.see(['triage C1:5.5: session: jev failed (timeout), reaction none 0.00, 4000 ms'], start + 3 * MIN)
  h.see(['afk: jev failed (timeout), using the Claude triage'], start + 4 * MIN)
  h.see(['answering C1:5.5 from app A0BOT0001: jev needs_reply 0.91 (threshold 0.5)'], start + 4 * MIN)
  h.see(['dropped C1:5.5 from app A0BOT0001: jev does not check this agent'], start + 4 * MIN)
  h.see(['dropped C1:5.5 from U0AAA0001 (app A0BOT0001): loop, too many turns: 5'], start + 4 * MIN)
  assert.equal(h.lines(start + 5 * MIN).at(-1), 'jev       on · 3 calls today, 1 failed')
  assert.equal(h.lines(Date.parse('2026-11-23T00:30:00')).at(-1), 'jev       on · 0 calls today')
})

test('a down WhatsApp bridge stays on the line until it is back, past the hour (#256 review)', () => {
  const h = started('whatsapp')
  h.see(['whatsapp bridge down'], start + MIN)
  assert.match(h.lines(start + 3 * 60 * MIN)[1]!, /^whatsapp  on · bridge down · /)
  h.see(['whatsapp bridge back'], start + 4 * 60 * MIN)
  assert.doesNotMatch(h.lines(start + 4 * 60 * MIN)[1]!, /bridge down/)
})

test('what Kage sent is not something heard, and a Slack post failure is not the connector failing', () => {
  const h = started('email', 'meetings')
  h.see(['mail sent for', 'ab12', 'to', 2, 'people'], start + MIN)
  h.see(['meeting post failed', new Error('not_in_channel')], start + MIN)
  assert.equal(h.lines(start + 2 * MIN)[0], 'email     on · nothing heard since the hub started 2m ago')
  assert.equal(h.lines(start + 2 * MIN)[3], 'meetings  on · nothing heard since the hub started 2m ago')
})

test('lines that name no connector, or name one in passing, change nothing', () => {
  const h = started('whatsapp')
  h.see(['tool dm: browser_tabs failed'], start + MIN)
  h.see([{ not: 'a string' }], start + MIN)
  h.see(['session for whatsapp ended'], start + MIN)
  assert.equal(h.lines(start + 2 * MIN)[1], 'whatsapp  on · nothing heard since the hub started 2m ago')
})

test('SMS shows on from its start line, and a text in counts as heard', () => {
  const h = started('sms')
  h.see(['sms text in'], start + 2 * MIN)
  assert.equal(h.lines(start + 5 * MIN).find(l => l.startsWith('sms')), 'sms       on · last heard 3m ago')
})
