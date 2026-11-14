import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { JEV_MAX_CHARS, OTHER_BAR, OWNER_BAR, TRIAGE_MAX_CHARS, jevChecks, jevConfig, jevRequest, jevVerdict, triageRequest, triageSkips, triageVerdict } from '../jev.ts'

describe('the Jev settings', () => {
  test('no key leaves Jev off', () => {
    assert.equal(jevConfig({}), undefined)
    assert.equal(jevConfig({ JEV_API_KEY: '  ' }), undefined)
  })
  test('a key alone checks every listed agent at 0.5 on the latest model', () => {
    assert.deepEqual(jevConfig({ JEV_API_KEY: 'apikey_test' }), { key: 'apikey_test', model: 'jev-latest', threshold: 0.5, agents: 'all' })
  })
  test('KAGE_JEV_AGENTS names the agents it checks; "all" or empty means every one', () => {
    const c = jevConfig({ JEV_API_KEY: 'k', KAGE_JEV_AGENTS: 'A0123ABC, A0456DEF' })
    assert.ok(c && !('error' in c))
    assert.deepEqual(c.agents, ['A0123ABC', 'A0456DEF'])
    assert.equal(jevChecks(c, 'A0123ABC'), true)
    assert.equal(jevChecks(c, 'A0999ZZZ'), false)
    const all = jevConfig({ JEV_API_KEY: 'k', KAGE_JEV_AGENTS: 'all' })
    assert.ok(all && !('error' in all) && all.agents === 'all' && jevChecks(all, 'A0999ZZZ'))
  })
  test('a wrong threshold or agent id is an error that names the setting, never the key', () => {
    for (const t of ['0', '1', 'high', '-0.2']) {
      const c = jevConfig({ JEV_API_KEY: 'apikey_secret', KAGE_JEV_THRESHOLD: t })
      assert.ok(c && 'error' in c && c.error.includes('KAGE_JEV_THRESHOLD') && !c.error.includes('apikey_secret'))
    }
    const c = jevConfig({ JEV_API_KEY: 'apikey_secret', KAGE_JEV_AGENTS: 'U0123ABC' })
    assert.ok(c && 'error' in c && c.error.includes('KAGE_JEV_AGENTS') && !c.error.includes('apikey_secret'))
  })
  test('a model and a threshold can be set', () => {
    assert.deepEqual(jevConfig({ JEV_API_KEY: 'k', KAGE_JEV_MODEL: 'jev-1.14.0', KAGE_JEV_THRESHOLD: '0.7' }), { key: 'k', model: 'jev-1.14.0', threshold: 0.7, agents: 'all' })
  })
})

describe('the question Jev is asked', () => {
  test('the post goes in as another agent\'s message, with one yes/no question', () => {
    const r = jevRequest('Done, posted it. Thanks!', 'jev-latest')
    assert.equal(r.model, 'jev-latest')
    assert.equal(r.state, 'Message from another AI agent: Done, posted it. Thanks!')
    assert.equal(r.questions.needs_reply.type, 'noul')
  })
  test('a long post is cut, not skipped', () => {
    const r = jevRequest('x'.repeat(JEV_MAX_CHARS + 500), 'm')
    assert.equal(r.state.length, 'Message from another AI agent: '.length + JEV_MAX_CHARS)
  })
})

describe('Jev\'s answer', () => {
  const answer = (noul: unknown) => ({ model: 'jev-1.14.0', answers: { needs_reply: { type: 'noul', noul } } })
  test('a score at or over the threshold starts a task; under it does not', () => {
    assert.deepEqual(jevVerdict(answer(0.99), 0.5), { reply: true, score: 0.99 })
    assert.deepEqual(jevVerdict(answer(0.5), 0.5), { reply: true, score: 0.5 })
    assert.deepEqual(jevVerdict(answer(0.04), 0.5), { reply: false, score: 0.04 })
  })
  test('an answer without a score is an error, so the caller answers anyway', () => {
    for (const b of [null, {}, { answers: {} }, answer('0.9'), answer(Number.NaN), { detail: { error_type: 'api_usage_error' } }])
      assert.ok('error' in jevVerdict(b, 0.5))
  })
})

describe('the intake question', () => {
  test('one choice, session or react, with a description for each option', () => {
    const q = triageRequest('thanks, done', 'jev-latest').questions.intake
    assert.equal(q.type, 'choice')
    assert.deepEqual(Object.keys(q.criteria), ['session', 'react'])
    assert.equal(triageRequest('x'.repeat(JEV_MAX_CHARS + 9), 'm').state.length, 'Message to an AI agent: '.length + JEV_MAX_CHARS)
  })
})

describe('triage skips: what never goes to Jev', () => {
  test('a question, a long message or one with files starts a session without a call', () => {
    const plain = { hasFiles: false, inThread: false }
    for (const t of ['can you check this?', 'can you check this？', 'هل يمكنك؟']) assert.ok(triageSkips(t, plain), t)
    assert.ok(triageSkips('x'.repeat(TRIAGE_MAX_CHARS + 1), plain))
    assert.ok(triageSkips('see this', { ...plain, hasFiles: true }))
    assert.ok(triageSkips('', plain))
    assert.equal(triageSkips('thanks, that works', plain), undefined)
  })
  test('a reply in a thread (a re-tag, or an answer to a waiting session) always starts a session', () => {
    assert.ok(triageSkips('ok do it', { hasFiles: false, inThread: true }))
  })
})

describe('Jev\'s intake answer', () => {
  const answer = (choice: string, react: number, extra: object = {}) =>
    ({ answers: { intake: { type: 'choice', choice, confidence: 1, probabilities: { session: 1 - react, react }, ...extra } } })
  test('react needs the choice and enough probability; the score is the react probability', () => {
    assert.deepEqual(triageVerdict(answer('react', 0.9), 'other'), { pick: 'react', score: 0.9 })
    assert.deepEqual(triageVerdict(answer('react', 0.7), 'other'), { pick: 'session', score: 0.7 })
    assert.deepEqual(triageVerdict(answer('session', 0.95), 'other'), { pick: 'session', score: 0.95 })
  })
  test('the owner needs a stricter bar than anyone else', () => {
    assert.deepEqual(triageVerdict(answer('react', 0.9), 'owner'), { pick: 'session', score: 0.9 })
    assert.deepEqual(triageVerdict(answer('react', 0.97), 'owner'), { pick: 'react', score: 0.97 })
    assert.ok(OWNER_BAR > OTHER_BAR)
  })
  test('an answer it cannot read is an error, so the caller starts a session', () => {
    for (const b of [null, {}, { answers: {} }, answer('ignore', 1), { answers: { intake: { choice: 'react' } } }, answer('react', Number.NaN)])
      assert.ok('error' in triageVerdict(b, 'other'), JSON.stringify(b))
  })
})
