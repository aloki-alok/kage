import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { dreamInput, dreamsDue, kageletDreamTask, memoryBlock, memoryPath, proposalFrom } from '../kagelet-memory.ts'
import type { KageEvent } from '../events.ts'

const DIR = '/h/kagelets'
const forbid = ['/h/mem/kage', '/h/mem/owner']

describe('where a kagelet memory file may live', () => {
  test('only a plain .md file inside its own folder under the kagelets folder', () => {
    assert.deepEqual(memoryPath(DIR, 'deploys', 'status-page.md', forbid), { path: '/h/kagelets/memory/deploys/status-page.md' })
    for (const f of ['../x.md', '/h/mem/owner/x.md', 'a/b.md', '.hidden.md', 'x.txt', 'x.md/', '', 'a\0.md', '..']) {
      assert.ok('error' in memoryPath(DIR, 'deploys', f, forbid), f)
    }
  })
  test('a name that could leave its folder is refused', () => {
    for (const n of ['../owner', 'a/b', '', 'Bad', '.']) assert.ok('error' in memoryPath(DIR, n, 'x.md', forbid), n)
  })
  test('a kagelets folder that overlaps Kage\'s or the owner\'s memory, either way round, is refused', () => {
    assert.match((memoryPath('/h/mem/owner/kagelets', 'a', 'x.md', forbid) as { error: string }).error, /memory/)
    assert.match((memoryPath('/h/mem', 'a', 'x.md', forbid) as { error: string }).error, /memory/)
    assert.match((memoryPath('/h/mem/kage', 'a', 'x.md', ['/h/mem/kage'])as { error: string }).error, /memory/)
    assert.ok('path' in memoryPath('/h/mem-other/kagelets', 'a', 'x.md', forbid))
  })
})

describe('a proposal', () => {
  test('is a file, its new text and a one-line reason, with bounds', () => {
    assert.deepEqual(proposalFrom({ file: 'a.md', text: 'Status page moved.', why: 'seen twice' }), { file: 'a.md', text: 'Status page moved.', why: 'seen twice' })
    assert.match((proposalFrom({ file: 'a.md', text: '', why: 'x' }) as { error: string }).error, /text/)
    assert.match((proposalFrom({ file: 'a.md', text: 'x'.repeat(4001), why: 'x' }) as { error: string }).error, /text/)
    assert.match((proposalFrom({ file: 'a.md', text: 'x', why: '' }) as { error: string }).error, /why/)
    assert.match((proposalFrom({ file: 'a.md', text: 'x', why: 'two\nlines' }) as { error: string }).error, /why/)
    assert.match((proposalFrom({ file: '../a.md', text: 'x', why: 'y' }) as { error: string }).error, /file/)
  })
})

describe('what the kagelet reads, and what its dream reads', () => {
  test('approved notes go into the kagelet prompt under their file names; none adds nothing', () => {
    assert.equal(memoryBlock([]), '')
    assert.match(memoryBlock([{ file: 'a.md', text: 'Use the v2 page.' }]), /Your memory[\s\S]*## a\.md\nUse the v2 page\./)
  })
  const ev = (kind: KageEvent['kind'], detail: string): KageEvent => ({ at: '2026-11-14T09:00:00.000Z', kind, who: 'deploys', trace: 't1', chain: '', detail, transcript: '/t/x.jsonl' })
  test('the dream task has its memory, the day\'s events and reports, and says proposals never apply on their own', () => {
    const t = kageletDreamTask('deploys', [{ file: 'a.md', text: 'Use v2.' }], [ev('report', 'ok'), ev('refusal', 'WebFetch: outside')], ['09:05 all green'], '2026-11-13T05:00:00.000Z')
    assert.match(t, /deploys/)
    assert.match(t, /## a\.md\nUse v2\./)
    assert.match(t, /report: ok/)
    assert.match(t, /refusal: WebFetch: outside/)
    assert.match(t, /09:05 all green/)
    assert.match(t, /propose_memory/)
    assert.match(t, /never applies on its own/)
    assert.doesNotMatch(t, /\/t\/x\.jsonl/)       // a row's transcript path is not handed over (ADR 0010)
  })
})

describe('which kagelets dream tonight', () => {
  const NIGHT = new Date(2026, 10, 14, 3, 0).getTime()
  const row = (name: string, state: 'runs' | 'paused' | 'broken' = 'runs') => ({ name, state })
  test('a running kagelet with a run since its last dream, in the small hours, with every session quiet', () => {
    const ran = new Map([['a', NIGHT - 3600_000]])
    assert.deepEqual(dreamsDue([row('a'), row('b')], ran, new Map(), NIGHT, true), ['a'])
  })
  test('not twice a night, not when its last run was before its last dream, not busy, not by day, not paused or broken', () => {
    const ran = new Map([['a', NIGHT - 3600_000], ['p', NIGHT - 1], ['q', NIGHT - 1]])
    assert.deepEqual(dreamsDue([row('a')], ran, new Map([['a', NIGHT - 3600_000 + 1]]), NIGHT, true), [])
    assert.deepEqual(dreamsDue([row('a')], ran, new Map(), NIGHT, false), [])
    assert.deepEqual(dreamsDue([row('a')], ran, new Map(), new Date(2026, 10, 14, 15).getTime(), true), [])
    assert.deepEqual(dreamsDue([row('p', 'paused'), row('q', 'broken')], ran, new Map(), NIGHT, true), [])
  })
})

describe('what one kagelet\'s dream takes from the shared logs', () => {
  const e = (at: string, who: string, kind: KageEvent['kind'] = 'tool'): KageEvent => ({ at, kind, who, trace: '', chain: '', detail: 'd', transcript: '' })
  test('only its own events and report lines, since its last dream', () => {
    const got = dreamInput('deploys', '2026-11-14T00:00:00.000Z',
      [e('2026-11-13T23:00:00.000Z', 'deploys'), e('2026-11-14T01:00:00.000Z', 'deploys'), e('2026-11-14T02:00:00.000Z', 'other'), e('2026-11-14T03:00:00.000Z', 'C1:5.5')],
      '2026-11-13T22:00:00.000Z\tdeploys\told\t\n2026-11-14T01:05:00.000Z\tdeploys\tall green\t\n2026-11-14T01:06:00.000Z\tother\tnot mine\t\n2026-11-14T01:07:00.000Z\tdeploys\tslow\tthe v2 key\n')
    assert.deepEqual(got.events.map(x => x.at), ['2026-11-14T01:00:00.000Z'])
    assert.deepEqual(got.reports, ['01:05 all green', '01:07 needs: the v2 key (slow)'])
  })
})
