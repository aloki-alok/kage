import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Schedule } from '../../core/cron.ts'
import { buildProbe, probeJobs } from '../probe-jobs.ts'
import { openStore } from '../store.ts'

type Wake = Parameters<typeof probeJobs>[0]['wake']

function setup(wake: Wake, id = 'p1', command?: string) {
  const dir = mkdtempSync(join(tmpdir(), 'kage-pwake-'))
  const data = join(dir, 'data.txt'), script = join(dir, 'probe.sh')
  writeFileSync(data, 'one\n'); writeFileSync(script, `cat ${data}\n`)
  const probe = buildProbe({ command: command ?? `sh ${script}` }, 200)
  if (typeof probe === 'string') throw new Error(probe)
  const s: Schedule = { id, key: 'C1:5.5', cron: '* * * * *', prompt: 'p', recurring: true, fromOwner: true, created: 0, lastFired: 0, trigger: { kind: 'probe', probe } }
  const store = openStore(':memory:')
  store.addSchedule(s)
  store.setJobState(id, { fails: 0, fp: 'before' })
  const events: string[] = [], dms: string[] = []
  const jobs = probeJobs({ store, settings: () => ({ failPing: 1 }), event: e => { events.push(e.detail) }, ping: async () => true, owner: t => { dms.push(t) }, wake, stateDir: join(dir, 'state') })
  const run = async () => { jobs.start(s, 0); await jobs.settled() }
  return { dir, store, events, dms, jobs, run, s }
}

test('a wake that throws is logged as an error, keeps the old state, and tells nobody', async () => {
  const t = setup(() => { throw new Error('boom') })
  await t.run()
  assert.ok(t.events.some(e => e.startsWith('wake ') && /reason=error/.test(e)), t.events.join('\n'))
  assert.equal(t.store.jobState('p1').fp, 'before')
  assert.deepEqual(t.dms, [])
})

test('a busy lane holds the wake: no blocked count, no note to the owner, and the old state stays', async () => {
  const t = setup(() => 'busy')
  await t.run()
  await t.run()
  const st = t.store.jobState('p1')
  assert.equal(st.fp, 'before')
  assert.equal(st.blocked, undefined)
  assert.deepEqual(t.dms, [])
})

test('only a job id of letters, digits, _ and - gets a state folder', async () => {
  const t = setup(() => 'sent', 'a.b')
  await t.run()
  assert.equal(existsSync(join(t.dir, 'state', 'a.b')), false)
  const ok = setup(() => 'sent', 'p_2-x')
  await ok.run()
  assert.equal(existsSync(join(ok.dir, 'state', 'p_2-x')), true)
})

test('tidy keeps the state folder of a job whose probe is still running, and removes the rest', async () => {
  const gate = mkdtempSync(join(tmpdir(), 'kage-pwake-gate-'))
  const t = setup(() => 'sent', 'p1', `sh -c 'while [ ! -f ${gate}/go ]; do sleep 0.05; done; echo x'`)
  mkdirSync(join(t.dir, 'state', 'gone'), { recursive: true })
  t.jobs.start(t.s, 0)
  for (let i = 0; i < 100 && !existsSync(join(t.dir, 'state', 'p1')); i++) await new Promise(r => setTimeout(r, 20))
  t.jobs.tidy(new Set())
  assert.equal(existsSync(join(t.dir, 'state', 'p1')), true)
  assert.equal(existsSync(join(t.dir, 'state', 'gone')), false)
  writeFileSync(join(gate, 'go'), '')
  await t.jobs.settled()
  rmSync(gate, { recursive: true, force: true })
})
