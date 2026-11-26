import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { KageEvent } from '../../core/events.ts'
import { telemetryExporter } from '../telemetry-export.ts'

const row = (id: number, kind: KageEvent['kind'], detail: string) =>
  ({ id, at: `2026-11-16T10:00:0${id % 10}.000Z`, kind, who: 'C0TESTCHAN1:1.2', trace: 't', chain: '', detail, transcript: '/Users/priya/t.jsonl' })

function fake(rows: ReturnType<typeof row>[], status: number[]) {
  const saved: unknown[] = [], bodies: string[] = []
  let cursor: number | undefined
  const exp = telemetryExporter({
    events: (after, limit) => rows.filter(r => r.id > after).slice(0, limit),
    maxId: () => Math.max(0, ...rows.map(r => r.id)),
    cursor: { load: () => cursor, save: n => { cursor = n; saved.push(n) } },
    post: async body => { bodies.push(body); return status.shift() ?? 200 },
    resource: { 'service.name': 'kage', 'kage.install': 'abc' },
  })
  return { exp, bodies, saved, cursor: () => cursor }
}

test('the first run sends no history: it starts after the newest row already there', async () => {
  const f = fake([row(1, 'run.end', '$0.10, no report'), row(2, 'tool', 'x ok')], [])
  await f.exp.run()
  assert.equal(f.bodies.length, 0)
  assert.equal(f.cursor(), 2)
})

test('new rows go out as one OTLP batch of gated records, and the cursor moves only on a 2xx', async () => {
  const rows = [row(1, 'run.end', '$0.10, no report')]
  const f = fake(rows, [503, 200])
  await f.exp.run()
  rows.push(row(2, 'run.end', '$0.19, reported Priya'), row(3, 'crash', 'a1b2c3d4e5f6'))
  await f.exp.run()
  assert.equal(f.cursor(), 1, 'a 503 keeps the rows for the next run')
  await f.exp.run()
  assert.equal(f.cursor(), 3)
  const body = JSON.parse(f.bodies[1]!)
  const recs = body.resourceLogs[0].scopeLogs[0].logRecords
  assert.deepEqual(recs.map((r: any) => r.body.stringValue), ['kage.run.end', 'kage.crash'])
  assert.deepEqual(recs[0].attributes, [{ key: 'cost_usd', value: { doubleValue: 0.19 } }, { key: 'report', value: { stringValue: 'yes' } }])
  assert.equal(recs[0].timeUnixNano, String(Date.parse('2026-11-16T10:00:02.000Z') * 1_000_000))
  assert.deepEqual(body.resourceLogs[0].resource.attributes, [{ key: 'service.name', value: { stringValue: 'kage' } }, { key: 'kage.install', value: { stringValue: 'abc' } }])
  assert.ok(!f.bodies[1]!.includes('Priya') && !f.bodies[1]!.includes('C0TESTCHAN1') && !f.bodies[1]!.includes('/Users'))
})

test('post rows stay on this machine: they are never sent, and a batch of only posts sends nothing but moves past them (#242)', async () => {
  const rows = [row(1, 'tool', 'ok')]
  const f = fake(rows, [])
  await f.exp.run()
  rows.push(row(2, 'post', 'reply bot channel'), row(3, 'run.end', '$0.10, no report'))
  await f.exp.run()
  rows.push(row(4, 'post', 'notice:slackDown bot dm'))
  await f.exp.run()
  assert.equal(f.bodies.length, 1)
  assert.deepEqual(JSON.parse(f.bodies[0]!).resourceLogs[0].scopeLogs[0].logRecords.map((r: any) => r.body.stringValue), ['kage.run.end'])
  assert.equal(f.cursor(), 4)
})

test('a 410 from the receiver stops sending for good in this process, the kill switch', async () => {
  const rows = [row(1, 'tool', 'ok')]
  const f = fake(rows, [410])
  await f.exp.run()
  rows.push(row(2, 'tool', 'ok'))
  await f.exp.run()
  rows.push(row(3, 'tool', 'ok'))
  await f.exp.run()
  assert.equal(f.bodies.length, 1)
})

test('a batch holds at most 500 rows, so a long gap drains over several runs', async () => {
  const rows = [row(0, 'tool', 'ok')]
  const f = fake(rows, [])
  await f.exp.run()
  for (let i = 1; i <= 1200; i++) rows.push(row(i, 'tool', 'ok'))
  await f.exp.run()
  assert.equal(f.cursor(), 500)
})

test('a batch the receiver refuses (400, 413) is skipped, a 429 is sent again', async () => {
  const rows = [row(0, 'tool', 'ok')]
  const f = fake(rows, [400, 429, 200])
  await f.exp.run()
  rows.push(row(1, 'tool', 'ok'))
  await f.exp.run()
  assert.equal(f.cursor(), 1, 'a 400 moves past the batch')
  rows.push(row(2, 'tool', 'ok'))
  await f.exp.run()
  assert.equal(f.cursor(), 1, 'a 429 keeps it')
  await f.exp.run()
  assert.equal(f.cursor(), 2)
})
