import { test } from 'node:test'
import assert from 'node:assert/strict'
import { jobRunner } from '../jobs.ts'

const tick = () => new Promise(r => setImmediate(r))
test('each job runs on its own period, and the first tick runs none until a period has passed', () => {
  const ran: string[] = []
  const j = jobRunner([{ name: 'fast', every: 20_000, run: () => void ran.push('fast') }, { name: 'slow', every: 60_000, run: () => void ran.push('slow') }], 0)
  j.tick(10_000)
  j.tick(20_000)
  j.tick(40_000)
  j.tick(60_000)
  assert.deepEqual(ran, ['fast', 'fast', 'fast', 'slow'])
})
test('a job that throws or rejects is logged and runs again next period; the others still run', async () => {
  const errors: string[] = []
  let ok = 0
  const j = jobRunner([
    { name: 'bad', every: 10, run: () => { throw new Error('boom') } },
    { name: 'sad', every: 10, run: async () => { throw new Error('later') } },
    { name: 'good', every: 10, run: () => void ok++ },
  ], 0, (name, e) => errors.push(`${name}: ${(e as Error).message}`))
  j.tick(10)
  await tick()
  j.tick(20)
  await tick()
  assert.equal(ok, 2)
  assert.deepEqual(errors, ['bad: boom', 'sad: later', 'bad: boom', 'sad: later'])
})
test('a slow async job is never started twice at once', async () => {
  let starts = 0
  let finish!: () => void
  const j = jobRunner([{ name: 'post', every: 10, run: () => { starts++; return new Promise<void>(r => { finish = r }) } }], 0)
  j.tick(10)
  j.tick(20)
  assert.equal(starts, 1)
  finish()
  await tick()
  j.tick(30)
  assert.equal(starts, 2)
})
