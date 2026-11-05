import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { filterRows, hit, layout, moreLine, STRING } from './loom.ts'
import { HERO_BIG, HERO_SMALL } from './hero.ts'
import type { Row, State } from './board.ts'

const row = (key: string, place = key, connector = 'slack'): Row => ({ key, place, connector, state: 'closed', label: 'closed', ageMs: 0 })

describe('where everything goes on screen', () => {
  const live = ['a', 'b', 'c'], ended = Array.from({ length: 40 }, (_, i) => `e${i}`)
  test('the big Kage needs 100 columns, a smaller one stays whole down to 70, and under that it is dropped', () => {
    assert.equal(layout(100, 38, live, ended).mode, 'big')
    assert.equal(layout(80, 38, live, ended).mode, 'small')
    assert.equal(layout(74, 38, live, ended).mode, 'small')
    assert.equal(layout(100, 26, live, ended).mode, 'small')
    assert.equal(layout(69, 38, live, ended).mode, 'none')
    assert.equal(layout(100, 20, live, ended).mode, 'none')
  })
  test('live rows come first, then a line, then as many ended rows as fit, then the count of the rest', () => {
    const l = layout(100, 38, live, ended)
    assert.deepEqual(l.live.map(r => r.key), ['a', 'b', 'c'])
    assert.equal(l.rowH, 3)
    assert.equal(l.live[1]!.y - l.live[0]!.y, 3)
    assert.ok(l.ended[0]!.y > l.live[2]!.y + 1)
    assert.equal(l.ended.length + l.more, 40)
    assert.ok(l.more > 0)
    assert.ok(l.ended.at(-1)!.y < l.moreY!)       // the count line never overlaps a row
    assert.ok(l.moreY! < 38 - 1)                  // and leaves the last line to the keys
  })
  test('rows get shorter before they run out of room, and nothing is drawn below the screen', () => {
    for (const rows of [38, 30, 24, 20]) {
      const l = layout(100, rows, ['a', 'b', 'c', 'd', 'e', 'f'], ended)
      for (const r of [...l.live, ...l.ended]) assert.ok(r.y < rows - 1, `row at ${r.y} on ${rows} lines`)
    }
    assert.ok(layout(100, 24, ['a', 'b', 'c', 'd', 'e', 'f'], ended).rowH < 3)
  })
  test('no ended threads means no count line', () => {
    const l = layout(100, 38, live, [])
    assert.equal(l.more, 0)
    assert.equal(l.moreY, undefined)
  })
  test('every string leaves the gold star in Kage\'s picture, and the rows start clear of Kage', () => {
    for (const [cols, rows, art] of [[100, 38, HERO_BIG], [80, 30, HERO_SMALL], [70, 24, HERO_SMALL]] as const) {
      const l = layout(cols, rows, live, [])
      const [sx, sy] = [l.star!.x - l.hero!.x, l.star!.y - l.hero!.y]
      assert.equal(art.cls[sy]![sx], 'g', `${cols}x${rows}: the star cell is gold`)
      assert.ok(l.lx - 4 > l.hero!.x + l.hero!.cols, `${cols}x${rows}: rows clear of Kage`)
    }
    assert.equal(layout(60, 38, live, []).star, undefined)
  })
})

describe('the list keeps a readable width', () => {
  test('on a wide terminal a row ends near its name, so the eye can follow it to its age', () => {
    const l = layout(190, 45, ['a'], ['x'])
    assert.ok(l.right - l.lx <= 80, `row is ${l.right - l.lx} columns wide`)
  })
  test('on a narrow terminal the row still runs to the edge', () => {
    assert.equal(layout(80, 24, ['a'], ['x']).right, 78)
  })
})

describe('which thread a mouse cell points at', () => {
  const l = layout(100, 38, ['a', 'b'], ['x', 'y'])
  test('a live row answers on its name line and its step line, from the string end to the right edge', () => {
    const a = l.live[0]!
    assert.equal(hit(l, l.lx + 3, a.y), 'a')
    assert.equal(hit(l, l.lx + 3, a.y + 1), 'a')
    assert.equal(hit(l, l.lx - 2, a.y), 'a')
    assert.equal(hit(l, l.right, a.y), 'a')
    assert.equal(hit(l, l.lx + 3, l.live[1]!.y), 'b')
  })
  test('the blank line between rows, the hero and the far edge answer nothing', () => {
    const a = l.live[0]!
    assert.equal(hit(l, l.lx + 3, a.y + 2), undefined)
    assert.equal(hit(l, 5, a.y), undefined)
    assert.equal(hit(l, l.right + 2, a.y), undefined)
  })
  test('an ended row answers on its one line', () => {
    assert.equal(hit(l, l.lx + 1, l.ended[1]!.y), 'y')
    assert.equal(hit(l, l.lx + 1, l.ended[1]!.y + 1), undefined)
  })
})

describe('search by place', () => {
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

describe('the line that counts what is not shown', () => {
  test('names the count and each channel', () => {
    const rest = [row('a', 'a', 'slack'), row('b', 'b', 'slack'), row('c', 'c', 'email'), row('d', 'd', 'whatsapp'), row('e', 'e', 'slack')]
    assert.equal(moreLine(rest), '+ 5 more · slack 3 · email 1 · whatsapp 1 · voice 0 · / to search')
  })
  test('counts voice calls too, so the parts add up to the total', () => {
    assert.equal(moreLine([row('a', 'a', 'voice'), row('b', 'b', 'slack')]), '+ 2 more · slack 1 · email 0 · whatsapp 0 · voice 1 · / to search')
  })
})

describe('each state has its own string', () => {
  const style = (s: State) => STRING[s]
  test('the language the owner approved', () => {
    assert.deepEqual(style('working'), { kind: 'pulse', tone: 'red', glyph: '●' })
    assert.deepEqual(style('asking'), { kind: 'blink', tone: 'gold', glyph: '◆' })
    assert.deepEqual(style('watching'), { kind: 'drift', tone: 'white', glyph: '◷' })
    assert.deepEqual(style('quiet'), { kind: 'dotted', tone: 'muted', glyph: '○' })
    assert.deepEqual(style('starting'), { kind: 'grow', tone: 'gold', glyph: '✦' })
  })
  test('a thread without a session has no string: queued waits loose, closed is cut', () => {
    assert.equal(style('queued').kind, 'none')
    assert.equal(style('closed').kind, 'cut')
  })
})
