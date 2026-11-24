import { test } from 'node:test'
import assert from 'node:assert/strict'
import { waitForQuiet } from '../quiet.ts'

const run = async (answers: ({ key: string; why: string }[] | { refused: string } | Error)[], cut = false) => {
  const said: string[] = []
  let asks = 0
  let sleeps = 0
  const r = await waitForQuiet({
    ask: async () => { const a = answers[Math.min(asks++, answers.length - 1)]!; if (a instanceof Error) throw a; return a },
    say: l => said.push(l), sleep: async () => { if (++sleeps > 50) throw new Error('waitForQuiet slept 50 times: it loops') }, placeOf: k => (k === 'C1:5.5' ? '#general' : k), cut, command: 'restart',
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
test('a hub that refuses the drain is never read as an older hub: nothing is cut, and the line names the command that cuts', async () => {
  const refused = { refused: "this needs the owner key, which only the kage command in the owner's own terminal sends" }
  const plain = await run([refused])
  assert.equal(plain.r, 'refused')
  assert.equal(plain.asks, 1)
  assert.deepEqual(plain.said, [`Kage refused this: ${refused.refused}.`, 'Nothing was cut. owner.key is likely missing or changed since the hub started. To restart anyway and cut every running turn: kage restart --cut-running'])
  assert.equal(plain.said.join(' ').match(/--cut-running/g)?.length, 1, 'one fix, for the command that was run')
  assert.ok(!plain.said.some(l => /older|cut\.$/.test(l)))
  const cut = await run([refused], true)
  assert.equal(cut.r, 'cut')
  assert.deepEqual(cut.said, [`Kage refused this: ${refused.refused}.`, 'Cutting every running turn, as --cut-running asked.'])
})
