import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { assignAnchors, bodyAnchors, filterRows, hit, layout, moreLine, segmentsCross, STRING } from './loom.ts'
import { HAND_BIG, HAND_SMALL } from '../hand.ts'
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
  test('the hand comes out of Kage and its fingertips end left of the rows', () => {
    for (const [cols, rows] of [[100, 38], [80, 30], [70, 24]] as const) {
      const l = layout(cols, rows, live, [])
      assert.ok(l.hand!.x < l.hero!.x + l.hero!.cols, 'overlaps Kage')
      assert.ok(l.hand!.x + l.hand!.cols < l.lx - 2, 'tips end before the rows')
      assert.ok(l.hand!.y + l.hand!.rows < rows - 1)
    }
    assert.equal(layout(60, 38, live, []).hand, undefined)
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
  const rows = [row('1', '#customer-acme'), row('2', 'DM with Pat'), row('3', '#Customer-Beta')]
  test('keeps the rows whose place contains the text, any case', () => {
    assert.deepEqual(filterRows(rows, 'customer').map(r => r.key), ['1', '3'])
    assert.deepEqual(filterRows(rows, 'PAT').map(r => r.key), ['2'])
  })
  test('empty text keeps every row; text that matches nothing keeps none', () => {
    assert.equal(filterRows(rows, '').length, 3)
    assert.equal(filterRows(rows, 'zzz').length, 0)
  })
})

describe('the line that counts what is not shown', () => {
  test('names the count and each channel', () => {
    const rest = [row('a', 'a', 'slack'), row('b', 'b', 'slack'), row('c', 'c', 'email'), row('d', 'd', 'email'), row('e', 'e', 'slack')]
    assert.equal(moreLine(rest), '+ 5 more · slack 3 · email 2 · / to search')
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

describe('which fingertip each string ties to', () => {
  // A hand reaching right: forearm, one finger out to the right, three hanging below, in dots.
  const DW = 40, DH = 24, mask = new Array<number>(DW * DH).fill(0)
  const box = (x0: number, y0: number, x1: number, y1: number) => { for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) mask[y * DW + x] = 1 }
  box(0, 6, 24, 14)        // forearm and palm
  box(24, 6, 40, 9)        // the reaching finger
  box(26, 14, 29, 22); box(31, 14, 34, 20); box(36, 14, 39, 18)   // three hanging fingers
  test('anchors: the reaching tip, the lowest fingertips and two knuckles, top to bottom', () => {
    const a = bodyAnchors(mask, DW, DH)
    assert.ok(a.length <= 6 && a.length >= 5)
    assert.deepEqual(a, [...a].sort((p, q) => p[1] - q[1] || q[0] - p[0]))
    assert.ok(a.some(([x, y]) => x === 19 && y === 1), 'the reaching fingertip')
    assert.ok(a.some(([x, y]) => x === 13 && y === 5), 'the longest hanging fingertip')
  })
  const A: [number, number][] = [[10, 1], [19, 1], [12, 3], [14, 5], [16, 4], [18, 3]]
  const rows = (n: number) => Array.from({ length: n }, (_, i) => 1 + i * 3)
  test('one row takes the reaching tip; several spread over the anchors', () => {
    assert.deepEqual(assignAnchors(A, rows(1), 40), [A[1]])
    const two = assignAnchors(A, rows(2), 40)
    assert.deepEqual(two, [A[0], A[5]])
  })
  test('no anchor takes two strings, and rows past the anchors leave the wrist', () => {
    for (let n = 1; n <= 9; n++) {
      const got = assignAnchors(A, rows(n), 40), real = got.filter(([x, y]) => A.some(a => a[0] === x && a[1] === y))
      assert.equal(got.length, n)
      assert.equal(real.length, Math.min(n, A.length))
      assert.equal(new Set(real.map(String)).size, real.length)
    }
    const past = assignAnchors(A, rows(8), 40).slice(6)
    assert.ok(past.every(([, y]) => y > 5), 'wrist exits sit below every anchor')
  })
  test('the same rows always get the same anchors', () => {
    assert.deepEqual(assignAnchors(A, rows(4), 40), assignAnchors(A, rows(4), 40))
  })
  test('anchors that would send two strings across each other are swapped to ones that do not', () => {
    // Anchor 0 is lower and further left than anchor 1; straight to rows 1 and 7 the strings cross.
    const B: [number, number][] = [[2, 9], [6, 3]]
    const got = assignAnchors(B, [1, 7], 40)
    assert.ok(!segmentsCross(got[0]!, [40, 1], got[1]!, [40, 7]))
  })
  test('on the real hand, strings to rows never cross, at every size and thread count', () => {
    for (const [cols, rows, art] of [[100, 38, HAND_BIG], [80, 30, HAND_SMALL], [70, 24, HAND_SMALL]] as const) {
      for (let n = 1; n <= 20; n++) {
        const l = layout(cols, rows, Array.from({ length: n }, (_, i) => `t${i}`), [])
        const abs = (art.anchors as [number, number][]).map(([x, y]) => [l.hand!.x + x + 1, l.hand!.y + y] as [number, number])
        const pts = assignAnchors(abs, l.live.map(r => r.y), l.lx - 2)
        const segs = l.live.map((r, i) => [pts[i]!, [l.lx - 2, r.y]] as const)
        for (let i = 0; i < segs.length; i++) for (let j = i + 1; j < segs.length; j++) assert.ok(!segmentsCross(segs[i]![0], segs[i]![1], segs[j]![0], segs[j]![1]), `${cols}x${rows} n=${n}: strings ${i} and ${j} cross`)
      }
    }
  })
})
