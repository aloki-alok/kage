import { test } from 'node:test'
import assert from 'node:assert/strict'
import { kageletReview } from '../kagelet-review.ts'

const KEY = 'C1:5.5#side-kagelet-ops'
const ops = { name: 'ops', key: KEY, tools: ['all'], job: 'Rebuild the docs.' }
function setup(o: { release?: 'rules' | 'review'; perDay?: number; answer?: string; tools?: string[] } = {}) {
  const asked: string[] = [], events: [string, string][] = []
  const r = kageletReview({
    settings: () => ({ release: o.release ?? 'review', perDay: o.perDay ?? 10, model: 'haiku' }),
    kagelet: key => key === KEY ? { ...ops, tools: o.tools ?? ops.tools } : undefined,
    ask: async a => { asked.push(a.prompt); return o.answer ?? 'RUN' },
    event: (key, detail) => { events.push([key, detail]) },
    today: () => '2026-11-16',
  })
  return { r, asked, events }
}

test('at release review, a low-stakes held step the model says RUN to runs, and the event row names the kind, never the command', async () => {
  const s = setup()
  assert.equal(await s.r(KEY, 'rm -rf build'), true)
  assert.match(s.asked[0]!, /Step: rm -rf build/)
  assert.deepEqual(s.events, [[KEY, 'released by reviewer: a forced or recursive delete']])
})
test('a HOLD keeps it held, and says so in the event row', async () => {
  const s = setup({ answer: 'HOLD: shared branch' })
  assert.equal(await s.r(KEY, 'git push --force origin feat/a'), false)
  assert.deepEqual(s.events, [[KEY, 'kept by reviewer: a forced push or a branch delete']])
})
test('nothing is asked at release rules (the default), for a prod step, for a kagelet without all, or for an unknown lane', async () => {
  for (const [s, key, c] of [[setup({ release: 'rules' }), KEY, 'rm -rf build'], [setup(), KEY, 'kubectl apply -f prod.yaml'], [setup({ tools: ['WebFetch'] }), KEY, 'rm -rf build'], [setup(), 'C9:1.1', 'rm -rf build']] as const) {
    assert.equal(await s.r(key, c), false, c)
    assert.deepEqual(s.asked, [], c)
  }
})
test('past the daily cap per kagelet, nothing more is asked or released that day', async () => {
  const s = setup({ perDay: 2 })
  for (let i = 0; i < 2; i++) assert.equal(await s.r(KEY, 'rm -rf build'), true)
  assert.equal(await s.r(KEY, 'rm -rf build'), false)
  assert.equal(s.asked.length, 2)
})
test('a failed model call keeps the step held', async () => {
  const s = kageletReview({ settings: () => ({ release: 'review', perDay: 10, model: 'haiku' }), kagelet: () => ops, ask: async () => { throw new Error('claude exited 1') }, event: () => {}, today: () => 'd' })
  assert.equal(await s(KEY, 'rm -rf build'), false)
})
