import { afterEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { connectSiri, siriWords, turnReplies, type Siri } from '../siri.ts'

const TOKEN = 'siri-test-1234567890'
const open: { close: () => Promise<void> }[] = []
afterEach(async () => { while (open.length) await open.pop()!.close() })

async function setup(o: { waitMs?: number; siri?: Siri; start?: (words: string) => Promise<string>; asking?: boolean } = {}) {
  const started: string[] = []
  const s = connectSiri({
    siri: { token: TOKEN, port: 0, ...o.siri }, waitMs: o.waitMs ?? 300,
    start: o.start ?? (async words => { started.push(words); return `D1:${started.length}` }),
    asking: () => o.asking ?? false,
  })!
  open.push(s)
  const port = await s.listening
  const ask = async (body: unknown, token = TOKEN) => {
    const r = await fetch(`http://127.0.0.1:${port}/ask`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) })
    const text = await r.text()
    return { status: r.status, json: text ? JSON.parse(text) as { state: string; say: string } : undefined }
  }
  return { s, port, started, ask }
}
const tick = (ms = 20) => new Promise(r => setTimeout(r, ms))

describe('the siri connector is opt-in', () => {
  test('it is off without a token and with the kill switch', () => {
    const base = { start: async () => '', asking: () => false }
    assert.equal(connectSiri({ ...base, siri: {} }), undefined)
    assert.equal(connectSiri({ ...base, siri: { token: TOKEN, on: false } }), undefined)
  })
})

describe('who may ask', () => {
  test('a wrong token gets a bare 401 and starts nothing', async () => {
    const s = await setup()
    const r = await s.ask({ text: 'hi' }, 'nope')
    assert.equal(r.status, 401)
    assert.equal(r.json, undefined)
    assert.deepEqual(s.started, [])
  })
  test('it listens on 127.0.0.1 only', async () => {
    const s = await setup()
    assert.equal(s.s.address(), '127.0.0.1')
  })
  test('empty words, a bad body and another path start nothing', async () => {
    const s = await setup()
    assert.equal((await s.ask({ text: '   ' })).status, 400)
    assert.equal((await s.ask('not json')).status, 400)
    const other = await fetch(`http://127.0.0.1:${s.port}/other`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` }, body: '{}' })
    assert.equal(other.status, 404)
    assert.deepEqual(s.started, [])
  })
  test('the hourly cap answers busy and starts nothing more', async () => {
    const s = await setup({ siri: { perHour: 1 }, waitMs: 10 })
    assert.equal((await s.ask({ text: 'one' })).status, 200)
    const r = await s.ask({ text: 'two' })
    assert.equal(r.status, 429)
    assert.equal(r.json?.state, 'busy')
    assert.deepEqual(s.started, ['one'])
  })
})

describe('what Siri says back', () => {
  test('a turn that ends inside the wait is spoken as the answer', async () => {
    const s = await setup({ waitMs: 2000 })
    const pending = s.ask({ text: 'what time is standup' })
    while (!s.started.length) await tick()
    await tick()
    s.s.ended('D1:1', () => [{ text: 'Standup is at *10:30*, see <https://x.y/z|the calendar>.' }])
    const r = await pending
    assert.equal(r.status, 200)
    assert.deepEqual(r.json, { state: 'answered', say: 'Standup is at 10:30, see the calendar.' })
  })
  test('a turn that ends on a question for the owner says the question and where to answer', async () => {
    const s = await setup({ waitMs: 2000 })
    const pending = s.ask({ text: 'investigate failed calls' })
    while (!s.started.length) await tick()
    await tick()
    s.s.ended('D1:1', () => [{ text: 'Which region?', asksOwner: 'Which region, us or eu?' }])
    const r = await pending
    assert.equal(r.json?.state, 'asks')
    assert.match(r.json!.say, /Which region, us or eu\?/)
    assert.match(r.json!.say, /Slack/)
  })
  test('work still running at the deadline is saved with its words, and the answer goes to Slack', async () => {
    const s = await setup({ waitMs: 50 })
    const r = await s.ask({ text: "Investigate yesterday's failed calls." })
    assert.equal(r.json?.state, 'working')
    assert.equal(r.json?.say, `I saved "Investigate yesterday's failed calls". I'll reply in Slack.`)
  })
  test('a turn waiting on an approval card at the deadline says so', async () => {
    const s = await setup({ waitMs: 50, asking: true })
    const r = await s.ask({ text: 'deploy the fix' })
    assert.equal(r.json?.state, 'approval')
    assert.match(r.json!.say, /approv/)
  })
  test('a turn that ends because it posted an approval card says so, not done', async () => {
    const s = await setup({ waitMs: 2000, asking: true })
    const pending = s.ask({ text: 'deploy the fix' })
    while (!s.started.length) await tick()
    await tick()
    s.s.ended('D1:1', () => [])
    assert.equal((await pending).json?.state, 'approval')
  })
  test('the end of another thread does not answer this one', async () => {
    const s = await setup({ waitMs: 150 })
    const pending = s.ask({ text: 'hello' })
    while (!s.started.length) await tick()
    s.s.ended('D1:other', () => [{ text: 'not yours' }])
    assert.equal((await pending).json?.state, 'working')
  })
  test('a start that fails says it could not save the words', async () => {
    const s = await setup({ start: async () => { throw new Error('slack down') } })
    const r = await s.ask({ text: 'hello' })
    assert.equal(r.status, 502)
    assert.equal(r.json?.state, 'failed')
  })
  test('a long answer is cut at a sentence and points to Slack', async () => {
    const s = await setup({ waitMs: 2000 })
    const pending = s.ask({ text: 'summarize' })
    while (!s.started.length) await tick()
    await tick()
    s.s.ended('D1:1', () => [{ text: `${'This is one sentence. '.repeat(60)}` }])
    const r = await pending
    assert.ok(r.json!.say.length <= 450, `${r.json!.say.length}`)
    assert.match(r.json!.say, /sentence\. The rest is in Slack\.$/)
  })
})

describe('the words Kage runs', () => {
  test('they carry the spoken words and the voice rules', () => {
    const w = siriWords('check the deploy')
    assert.match(w, /check the deploy/)
    assert.match(w, /heard, not typed/)
    assert.match(w, /yes/)
  })
})

describe('the answer read from the transcript', () => {
  test('it keeps every reply tool call with its waiting question, skips other lines, and a missing file reads as none', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const file = `${mkdtempSync(`${tmpdir()}/kage-siri-`)}/t.jsonl`
    const reply = (input: object) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'mcp__kage__reply', input }] } })
    writeFileSync(file, [JSON.stringify({ type: 'user', message: { content: 'hi' } }), reply({ text: 'Looking.' }), 'not json', reply({ text: 'Which region?', waiting: 'Which region?', waiting_on: 'owner' })].join('\n'))
    assert.deepEqual(turnReplies(file), [{ text: 'Looking.' }, { text: 'Which region?', asksOwner: 'Which region?' }])
    assert.deepEqual(turnReplies(`${file}.gone`), [])
  })
})
