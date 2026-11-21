import { test } from 'node:test'
import assert from 'node:assert/strict'
import { statsLines } from '../stats.ts'
import type { KageEvent } from '../events.ts'

const DAY = 86_400_000
const now = new Date(2026, 10, 15, 12, 0).getTime()
const ev = (at: number, kind: KageEvent['kind'], trace: string, who = 'C0TEST1:1.1'): KageEvent =>
  ({ at: new Date(at).toISOString(), kind, who, trace, chain: '', detail: '', transcript: '' })

test('spend and turns per day, spend per connector, runs, refusals, turn time and hub starts', () => {
  const lines = statsLines({
    days: 2, now,
    costs: [
      { at: now - 1000, key: 'C0TEST1:1.1', usd: 1.5 },
      { at: now - 2000, key: 'mail:<a@x>', usd: 0.5 },
      { at: now - DAY, key: 'C0TEST1:1.1#side-kagelet-deploys', usd: 2 },
      { at: now - 5 * DAY, key: 'C0TEST1:1.1', usd: 99 },
    ],
    events: [
      ev(now - 60_000, 'run.start', 't1'), ev(now - 30_000, 'run.end', 't1'),
      ev(now - 200_000, 'run.start', 't2'), ev(now - 80_000, 'run.end', 't2'),
      ev(now - 10_000, 'run.start', 't3'),
      ev(now - 5000, 'refusal', 't3'),
    ],
    boots: [now - 3600_000, now - DAY - 1000],
  })
  const text = lines.join('\n')
  assert.match(text, /^Last 2 days: \$4\.00 over 3 turns/)
  assert.match(text, /11-15 +\$2\.00 +2 turns$/m)
  assert.match(text, /11-14 +\$2\.00 +1 turn$/m)
  assert.match(text, /hub: 1 start in the last 24 h/)
  assert.match(text, /slack \$1\.50 · email \$0\.50 · kagelets \$2\.00/)
  assert.match(text, /runs: 3 started, 2 ended, 1 refusal/)
  assert.match(text, /turn time: p50 30s, p90 2m/)
  assert.doesNotMatch(text, /99/)
})

test('tokens per turn: the total, the share read from cache, and each kind of thread; older rows are counted apart (#505)', () => {
  const t = (input: number, cacheWrite: number, cacheRead: number, output: number, who: string) => ({ input, cacheWrite, cacheRead, output, who })
  const text = statsLines({
    days: 1, now, events: [], boots: [],
    costs: [
      { at: now - 1000, key: 'C0TEST1:1.1', usd: 1, tokens: t(10, 2000, 18_000, 500, 'owner') },
      { at: now - 2000, key: 'C0TEST1:1.1#side-kagelet-calls', usd: 0.5, tokens: t(0, 10_000, 70_000, 1500, 'kagelet') },
      { at: now - 3000, key: 'C0TEST1:2.2', usd: 0.2 },
    ],
  }).join('\n')
  assert.match(text, /tokens: 100k in, 88% read from cache, 2k out over 2 turns \(1 turn from before tokens were kept\)/)
  assert.match(text, /by kind: kagelet 80k · owner 20k$/m)
  assert.match(text, /11-15 +\$1\.70 +3 turns  100k tokens in$/m)
})

test('nothing recorded says so', () => {
  assert.deepEqual(statsLines({ days: 7, now, costs: [], events: [], boots: [] }), ['Last 7 days: nothing spent, no runs, no hub starts.'])
})
