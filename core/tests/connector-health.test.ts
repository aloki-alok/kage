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
  assert.equal(h.lines(start + 5 * MIN)[5], 'jev       on · 3 calls today, 2 failed')
  assert.equal(h.lines(Date.parse('2026-11-23T00:30:00'))[5], 'jev       on · 0 calls today')
})

test('lines that name no connector, or name one in passing, change nothing', () => {
  const h = started('whatsapp')
  h.see(['tool dm: browser_tabs failed'], start + MIN)
  h.see([{ not: 'a string' }], start + MIN)
  h.see(['session for whatsapp ended'], start + MIN)
  assert.equal(h.lines(start + 2 * MIN)[1], 'whatsapp  on · nothing heard since the hub started 2m ago')
})
