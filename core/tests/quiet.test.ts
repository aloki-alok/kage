import { test } from 'node:test'
import assert from 'node:assert/strict'
import { waitForQuiet } from '../quiet.ts'

const run = async (answers: ({ key: string; why: string }[] | Error)[], cut = false) => {
  const said: string[] = []
  let asks = 0
  const r = await waitForQuiet({
    ask: async () => { const a = answers[Math.min(asks++, answers.length - 1)]!; if (a instanceof Error) throw a; return a },
    say: l => said.push(l), sleep: async () => {}, placeOf: k => (k === 'C1:5.5' ? '#general' : k), cut,
  })
  return { r, said, asks }
}

test('it names each thread it waits on once, and finishes when none is left', async () => {
  const { r, said, asks } = await run([[{ key: 'C1:5.5', why: 'busy' }], [{ key: 'C1:5.5', why: 'busy' }, { key: 'dm', why: 'asking' }], []])
  assert.equal(r, 'quiet')
  assert.equal(asks, 3)
  assert.deepEqual(said, ['Waiting for #general (busy) to finish its turn.', 'Waiting for dm (asking) to finish its turn.', 'Every thread is quiet.'])
})
test('--cut-running asks once and names each thread it cuts', async () => {
  const { r, said, asks } = await run([[{ key: 'C1:5.5', why: 'busy' }]], true)
  assert.equal(r, 'cut')
  assert.equal(asks, 1)
  assert.deepEqual(said, ['Cutting #general (busy).'])
})
test('no hub running means nothing to wait for; an older hub that cannot drain is cut, and says so', async () => {
  assert.equal((await run([new Error('down')])).r, 'down')
  const old = await run([new Error('silent')])
  assert.equal(old.r, 'cut')
  assert.match(old.said[0]!, /cannot wait/)
})
test('a missed answer after a good one is a slow hub, not an old one: it asks again instead of cutting', async () => {
  const { r, said } = await run([[{ key: 'C1:5.5', why: 'busy' }], new Error('silent'), []])
  assert.equal(r, 'quiet')
  assert.ok(!said.some(l => /cannot wait/.test(l)))
})
test('a hub that stops answering for 5 asks in a row is cut, so kage stop never hangs', async () => {
  const { r, said, asks } = await run([[{ key: 'C1:5.5', why: 'busy' }], new Error('silent')])
  assert.equal(r, 'cut')
  assert.equal(asks, 6)
  assert.match(said.at(-1)!, /does not answer/)
})
