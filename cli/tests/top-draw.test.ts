import { test } from 'node:test'
import assert from 'node:assert/strict'
import { drawFrame, type Tab, type View } from '../top-draw.ts'
import { resize, toText } from '../top-screen.ts'
import type { KageletRow } from '../../core/kagelets.ts'

const NOW = Date.parse('2026-11-19T14:22:00Z')
const kagelet: KageletRow = { name: 'deploy-watch', state: 'runs', cron: '*/30 * * * *', tools: [], costToday: 0.11, avg7: 0.09, result: { at: NOW, summary: 'CI green on main' } }

function frame(tab: Tab, cols = 132, rows = 38): string[] {
  resize({ cols, rows })
  const v: View = {
    now: NOW, t: 0, since: 1e9, slack: true, hubUp: true, spentToday: 1.2,
    rows: [{ key: 'C0TEST1:1.0', place: '#infra-alerts', connector: 'slack', state: 'working', label: 'working', ageMs: 8_000 }],
    nowLine: () => 'read deploy.log', tab, focus: 'list', selKey: 'C0TEST1:1.0', mode: 'steps',
    feed: [{ at: NOW, text: 'read   deploy.log' }], typed: Infinity, threadSpend: 0,
    schedules: [{ id: 's1', key: 'C0TEST1:1.0', cron: '*/5 * * * *', prompt: 'check CI', recurring: true, fromOwner: true, created: NOW, lastFired: 0 }],
    nextOf: () => NOW + 60_000, placeOf: () => '#infra-alerts',
    kagelets: [kagelet], pick: 0, runs: [], turns: [], costs: [], query: '', searching: false,
  }
  drawFrame(v)
  return toText().map(l => l.replace(/\x1b\[[0-9;]*m/g, ''))
}

test('only the main tabs are numbered: the steps pane names its views without numbers', () => {
  const text = frame('threads').join('\n')
  assert.match(text, /¹threads/)
  assert.doesNotMatch(text, /¹steps|²schedules ─/)
})

test('the kagelets and schedules tabs take the full width, with no stale steps beside them', () => {
  for (const tab of ['kagelets', 'schedules'] as const) {
    const text = frame(tab).join('\n')
    assert.doesNotMatch(text, /read deploy\.log/, `${tab}: the thread's steps still show`)
  }
  assert.match(frame('kagelets').join('\n'), /LAST REPORT/)
})
