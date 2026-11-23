import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startsSince, startsLine } from '../boots.ts'

const NOW = 100_000
const lines = (...l: string[]) => l.join('\n') + '\n'

test('each start is counted by why the hub stopped before it, and only within 24 h (#255)', () => {
  const s = startsSince(lines('1000 update', '99001 update', '99002 restart', '99003 restart', '99004 settings', '99005 crash TypeError: x is undefined', '99006 unknown', '99007', '99008 first'), NOW - 86_400)
  assert.deepEqual(s, { total: 8, update: 1, settings: 1, restart: 2, crash: 1, unknown: 1, first: 1, unrecorded: 1, lastCrash: 'TypeError: x is undefined' })
})
test('the line puts crashes first, then the rest, and leaves out causes with none', () => {
  assert.equal(startsLine(startsSince(lines(...Array.from({ length: 29 }, (_, i) => `${99_000 + i} update`), ...Array.from({ length: 33 }, (_, i) => `${99_100 + i} restart`), '99200 settings'), 0)),
    '63 starts in 24 h: 29 updates, 33 restarts, 1 settings change, 0 crashes')
  assert.equal(startsLine(startsSince(lines('99001 crash boom', '99002 crash boom', '99003 update', '99004 unknown'), 0)), '4 starts in 24 h: 2 crashes, 1 unknown, 1 update')
  assert.equal(startsLine(startsSince(lines('99001', '99002 restart'), 0)), '2 starts in 24 h: 1 restart, 1 from before Kage kept causes, 0 crashes')
  assert.equal(startsLine(startsSince(lines('99001 first', '99002 update'), 0)), '2 starts in 24 h: 1 update, the first start, 0 crashes')
  assert.equal(startsLine(startsSince(undefined, 0)), '0 starts in 24 h')
})
