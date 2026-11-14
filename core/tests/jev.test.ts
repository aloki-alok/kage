import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { afkRequest, afkVerdict, JEV_MAX_CHARS, OTHER_BAR, OWNER_BAR, TRIAGE_MAX_CHARS, jevChecks, jevConfig, jevRequest, jevVerdict, triageRequest, triageSkips, triageVerdict } from '../jev.ts'

describe('the Jev settings', () => {
  test('no key leaves Jev off', () => {
    assert.equal(jevConfig({}), undefined)
    assert.equal(jevConfig({}, '  '), undefined)
  })
  test('a key alone checks every listed agent at 0.5 on the latest model', () => {
    assert.deepEqual(jevConfig({}, 'apikey_test'), { key: 'apikey_test', model: 'jev-latest', threshold: 0.5, agents: 'all' })
  })
  test('jev.agents names the agents it checks; "all" or empty means every one', () => {
    const c = jevConfig({ agents: ['A0123ABC', 'A0456DEF'] }, 'k')
    assert.ok(c && !('error' in c))
    assert.deepEqual(c.agents, ['A0123ABC', 'A0456DEF'])
    assert.equal(jevChecks(c, 'A0123ABC'), true)
    assert.equal(jevChecks(c, 'A0999ZZZ'), false)
    const all = jevConfig({ agents: ['all'] }, 'k')
    assert.ok(all && !('error' in all) && all.agents === 'all' && jevChecks(all, 'A0999ZZZ'))
  })
  test('a wrong threshold or agent id is an error that names the setting, never the key', () => {
    for (const t of [0, 1, -0.2]) {
      const c = jevConfig({ threshold: t }, 'apikey_secret')
      assert.ok(c && 'error' in c && c.error.includes('jev.threshold') && !c.error.includes('apikey_secret'))
    }
    const c = jevConfig({ agents: ['U0123ABC'] }, 'apikey_secret')
    assert.ok(c && 'error' in c && c.error.includes('jev.agents') && !c.error.includes('apikey_secret'))
  })
  test('a model and a threshold can be set', () => {
    assert.deepEqual(jevConfig({ model: 'jev-1.14.0', threshold: 0.7 }, 'k'), { key: 'k', model: 'jev-1.14.0', threshold: 0.7, agents: 'all' })
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

describe('the AFK question', () => {
  test('urgency is a choice of four, and waiting on the owner and a lookup are yes/no scores', () => {
    const r = afkRequest({ owner: 'Sam', place: '#eng', from: 'Maya', convo: 'hello' }, 'jev-latest')
    assert.equal(r.questions.urgency.type, 'choice')
    assert.deepEqual(Object.keys(r.questions.urgency.criteria), ['p0', 'high', 'normal', 'low'])
    assert.equal(r.questions.waits.type, 'noul')
    assert.equal(r.questions.lookup.type, 'noul')
    assert.match(r.state, /Sam is away/)
    assert.equal(afkRequest({ owner: 'Sam', place: 'x', from: 'y', convo: 'z'.repeat(JEV_MAX_CHARS * 2) }, 'm').state.length < JEV_MAX_CHARS + 400, true)
  })
})

describe('Jev\'s AFK answer', () => {
  const answer = (choice: string, top: number, waits: unknown = 0.9, lookup: unknown = 0.1) => ({ answers: {
    urgency: { type: 'choice', choice, confidence: 1, probabilities: { [choice]: top } },
    waits: { type: 'noul', noul: waits }, lookup: { type: 'noul', noul: lookup } } })
  test('the choice gives the urgency, and the scores give waits and lookup at 0.5', () => {
    assert.deepEqual(afkVerdict(answer('high', 0.9, 0.9, 0.1)), { urgency: 'high', waits: true, lookup: false })
    assert.deepEqual(afkVerdict(answer('low', 0.9, 0.2, 0.7)), { urgency: 'low', waits: false, lookup: true })
  })
  test('a p0 needs high probability, else it is high: a wrong p0 wakes the owner', () => {
    assert.equal((afkVerdict(answer('p0', 0.95)) as { urgency: string }).urgency, 'p0')
    assert.equal((afkVerdict(answer('p0', 0.6)) as { urgency: string }).urgency, 'high')
  })
  test('an answer it cannot read is an error, so the caller uses the Claude triage', () => {
    for (const b of [null, {}, answer('urgent', 1), answer('low', 1, 'x'), answer('low', 1, 0.5, Number.NaN), { answers: { urgency: { choice: 'low' } } }])
      assert.ok('error' in afkVerdict(b), JSON.stringify(b))
  })
})
