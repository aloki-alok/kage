import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { bars, filterRows, listRows, MARK, perMinute, perHour, rowAt, screen, spinner } from '../top-layout.ts'
import type { Row } from '../board.ts'

describe('screen: which panes a terminal gets', () => {
  test('a wide, tall terminal gets the list, the steps beside it, and the charts below', () => {
    const s = screen(132, 38, false)
    assert.deepEqual(s.list, { x0: 1, y0: 2, x1: 70, y1: 26 })
    assert.deepEqual(s.feed, { x0: 72, y0: 2, x1: 130, y1: 26 })
    assert.deepEqual(s.charts!.map(c => c.x1 - c.x0 > 10), [true, true, true])
    assert.equal(s.charts![0]!.y1, 36)
  })
  test('the ask banner takes one row, and every pane moves down for it', () => {
    const a = screen(132, 38, true), b = screen(132, 38, false)
    assert.equal(a.banner, 1)
    assert.equal(b.banner, undefined)
    assert.equal(a.list.y0, b.list.y0 + 1)
    assert.equal(a.charts![0]!.y1, b.charts![0]!.y1)
  })
  test('a narrow terminal stacks: the list fills it, and the steps open in its place', () => {
    const s = screen(90, 38, false)
    assert.equal(s.feed, undefined)
    assert.equal(s.list.x1, 88)
  })
  test('charts start at 30 rows and the steps pane at 110 columns', () => {
    assert.ok(screen(132, 30, false).charts)
    assert.equal(screen(132, 29, false).charts, undefined)
    assert.ok(screen(110, 38, false).feed)
    assert.equal(screen(109, 38, false).feed, undefined)
  })
  test('a short terminal drops the charts before it shrinks the list', () => {
    assert.equal(screen(132, 26, false).charts, undefined)
    assert.equal(screen(132, 26, false).list.y1, 24)
  })
  test('nothing reaches the footer row', () => {
    for (const [w, h, ask] of [[132, 38, true], [80, 24, true], [60, 18, false]] as const) {
      const s = screen(w, h, ask)
      for (const r of [s.list, s.feed, ...(s.charts ?? [])].filter(Boolean)) assert.ok(r!.y1 < h - 1, `${w}x${h}`)
    }
  })
})

describe('the thread list scrolls to keep the selection in view', () => {
  const rows = Array.from({ length: 30 }, (_, i) => `k${i}`)
  test('the top of the list when the selection fits', () => {
    assert.deepEqual(listRows(rows, 'k3', 10).slice(0, 2), [{ key: 'k0', y: 0 }, { key: 'k1', y: 1 }])
  })
  test('a selection below the fold scrolls just far enough', () => {
    const shown = listRows(rows, 'k25', 10)
    assert.equal(shown.length, 10)
    assert.equal(shown.at(-1)!.key, 'k25')
  })
  test('rowAt maps a screen line back to its key, and blank lines to nothing', () => {
    const shown = listRows(rows, 'k0', 5)
    assert.equal(rowAt(shown, 2), 'k2')
    assert.equal(rowAt(shown, 9), undefined)
  })
})

describe('charts', () => {
  const NOW = Date.parse('2026-11-19T14:22:30Z')
  test('perMinute counts events into the last hour, oldest left, now right', () => {
    const at = (min: number) => NOW - min * 60_000
    const bins = perMinute([at(0.2), at(0.5), at(59.5), at(61), NaN], NOW, 60)
    assert.equal(bins.length, 60)
    assert.equal(bins[59], 2)
    assert.equal(bins[0], 1)
    assert.equal(bins.reduce((a, b) => a + b, 0), 3)
  })
  test('perMinute squeezes the hour into fewer columns when the pane is narrow', () => {
    const bins = perMinute([NOW, NOW - 30 * 60_000], NOW, 20)
    assert.equal(bins.length, 20)
    assert.equal(bins.reduce((a, b) => a + b, 0), 2)
  })
  test('perHour sums spend by local hour from midnight to now', () => {
    const midnight = new Date(NOW).setHours(0, 0, 0, 0)
    const hours = perHour([{ at: midnight + 30 * 60_000, usd: 0.1 }, { at: midnight + 90 * 60_000, usd: 0.2 }, { at: midnight - 1, usd: 9 }], NOW)
    assert.equal(hours.length, new Date(NOW).getHours() + 1)
    assert.deepEqual(hours.slice(0, 2), [0.1, 0.2])
  })
  test('bars draws values as block columns, the tallest reaching the top', () => {
    assert.deepEqual(bars([0, 4, 8], 2), ['  █', ' ██'])
    assert.deepEqual(bars([0, 1, 2], 1), [' ▄█'])
  })
  test('bars of nothing is blank, never NaN', () => {
    assert.deepEqual(bars([0, 0], 2), ['  ', '  '])
  })
})

describe('marks', () => {
  test('each state has its own mark, and only asking uses the warm color', () => {
    assert.deepEqual(Object.entries(MARK).filter(([, m]) => m.tone === 'you').map(([s]) => s), ['asking'])
    assert.equal(new Set(Object.values(MARK).map(m => m.glyph)).size, Object.keys(MARK).length - 1)
  })
  test('a working thread spins: the frame follows the clock', () => {
    assert.notEqual(spinner(0), spinner(100))
    assert.equal(spinner(0), spinner(50))
    assert.equal(spinner(0), spinner(1000))
  })
})

test('rows type is the board row', () => {
  const r: Row = { key: 'k', place: 'p', connector: 'slack', state: 'working', label: 'working', ageMs: 0 }
  assert.equal(MARK[r.state].tone, 'work')
})

describe('search by place', () => {
  const row = (key: string, place: string): Row => ({ key, place, connector: 'slack', state: 'quiet', label: 'quiet', ageMs: 0 })
  const rows = [row('1', '#customer-support'), row('2', 'DM with Jay'), row('3', '#Customer-Acme')]
  test('keeps the rows whose place contains the text, any case', () => {
    assert.deepEqual(filterRows(rows, 'customer').map(r => r.key), ['1', '3'])
    assert.deepEqual(filterRows(rows, 'JAY').map(r => r.key), ['2'])
  })
  test('empty text keeps every row; text that matches nothing keeps none', () => {
    assert.equal(filterRows(rows, '').length, 3)
    assert.equal(filterRows(rows, 'zzz').length, 0)
  })
})
