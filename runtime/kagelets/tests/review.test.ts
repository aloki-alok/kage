import { test } from 'node:test'
import assert from 'node:assert/strict'
import { kageletReview } from '../review.ts'

const KEY = 'C1:5.5#side-kagelet-ops'
const ops = { name: 'ops', key: KEY, tools: ['all'], job: 'Rebuild the docs.' }
function setup(o: { release?: 'rules' | 'review' | 'shadow'; perDay?: number; answer?: string; tools?: string[] } = {}) {
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
  assert.deepEqual(await s.r(KEY, 'rm -rf build'), { release: true, said: 'run' })
  assert.match(s.asked[0]!, /Step: rm -rf build/)
  assert.deepEqual(s.events, [[KEY, 'released by reviewer: a forced or recursive delete']])
})
test('a HOLD keeps it held, and says so in the event row', async () => {
  const s = setup({ answer: 'HOLD: shared branch' })
  assert.deepEqual(await s.r(KEY, 'git push --force origin feat/a'), { release: false, said: 'hold' })
  assert.deepEqual(s.events, [[KEY, 'kept by reviewer: a forced push or a branch delete']])
})
test('nothing is asked at release rules (the default), for a prod step, for a kagelet without all, or for an unknown lane', async () => {
  for (const [s, key, c] of [[setup({ release: 'rules' }), KEY, 'rm -rf build'], [setup(), KEY, 'kubectl apply -f prod.yaml'], [setup({ tools: ['WebFetch'] }), KEY, 'rm -rf build'], [setup(), 'C9:1.1', 'rm -rf build']] as const) {
    assert.deepEqual(await s.r(key, c), { release: false }, c)
    assert.deepEqual(s.asked, [], c)
  }
})
test('past the daily cap per kagelet, nothing more is asked or released that day', async () => {
  const s = setup({ perDay: 2 })
  for (let i = 0; i < 2; i++) assert.equal((await s.r(KEY, 'rm -rf build')).release, true)
  assert.deepEqual(await s.r(KEY, 'rm -rf build'), { release: false })
  assert.equal(s.asked.length, 2)
})
test('a failed model call keeps the step held', async () => {
  const s = kageletReview({ settings: () => ({ release: 'review', perDay: 10, model: 'haiku' }), kagelet: () => ops, ask: async () => { throw new Error('claude exited 1') }, event: () => {}, today: () => 'd' })
  assert.deepEqual(await s(KEY, 'rm -rf build'), { release: false })
})
test('parallel calls never pass the daily cap', async () => {
  const s = setup({ perDay: 2 })
  const all = await Promise.all(Array.from({ length: 6 }, () => s.r(KEY, 'rm -rf build')))
  assert.equal(all.filter(r => r.release).length, 2)
  assert.equal(s.asked.length, 2)
})
test('a HOLD gives its slot back, so only released steps count', async () => {
  let answer = 'HOLD: no'
  const r = kageletReview({ settings: () => ({ release: 'review', perDay: 1, model: 'haiku' }), kagelet: () => ops, ask: async () => answer, event: () => {}, today: () => 'd' })
  assert.equal((await r(KEY, 'rm -rf build')).release, false)
  answer = 'RUN'
  assert.equal((await r(KEY, 'rm -rf build')).release, true)
})
test('at release shadow, the reviewer gives its verdict but never releases, and the event row says what it would do', async () => {
  for (const [answer, said] of [['RUN', 'run'], ['HOLD: shared branch', 'hold']] as const) {
    const s = setup({ release: 'shadow', answer })
    assert.deepEqual(await s.r(KEY, 'rm -rf build'), { release: false, said })
    assert.deepEqual(s.events, [[KEY, `shadow reviewer would ${said}: a forced or recursive delete`]])
  }
})
test('at release shadow, every ask counts toward the daily cap, since none is a release', async () => {
  const s = setup({ release: 'shadow', perDay: 2, answer: 'HOLD: no' })
  for (let i = 0; i < 3; i++) await s.r(KEY, 'rm -rf build')
  assert.equal(s.asked.length, 2)
})
