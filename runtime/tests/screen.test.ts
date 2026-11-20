import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname } from 'node:path'
import { screenRecorder, type Launch } from '../screen.ts'

function fakeHelper(answer: (job: { action: string; out: string; seconds?: number; app?: string }) => string[], jobs: unknown[] = []) {
  const stops = new Map<number, () => void>()
  let pid = 100
  const launch: Launch = (app, log) => {
    const job = JSON.parse(readFileSync(`${dirname(app)}/job.json`, 'utf8'))
    jobs.push({ ...job, mode: statSync(`${dirname(app)}/job.json`).mode & 0o777 })
    const me = ++pid
    const lines = answer(job)
    const exited = new Promise<number>(done => {
      if (lines[0]?.includes('"recording"')) {
        appendFileSync(log, lines[0].replace('PID', String(me)) + '\n')
        stops.set(me, () => { appendFileSync(log, lines[1] + '\n'); done(0) })
      } else { for (const l of lines) appendFileSync(log, l + '\n'); done(lines.some(l => l.includes('"error"')) ? 1 : 0) }
    })
    return { exited }
  }
  const kill = (p: number) => stops.get(p)?.()
  return { launch, kill }
}
const RECORDS = () => ['{"state":"recording","pid":PID}', '{"state":"saved","seconds":42}']

describe('Kage Screen in the hub', () => {
  const setup = (answer = RECORDS, built: string[] = []) => {
    const dir = mkdtempSync(`${tmpdir()}/kage-screen-`), jobs: Record<string, unknown>[] = []
    const h = fakeHelper(answer, jobs)
    const screen = screenRecorder({ dir, code: '/code', build: async app => { built.push(app); return undefined }, launch: h.launch, kill: h.kill, pollMs: 5 })
    return { dir, screen, jobs, built }
  }
  test('a recording starts, keeps running, and stop hands back the saved file and its length', async () => {
    const { screen, jobs } = setup()
    assert.equal(await screen.start('/t/a.mp4', 120), undefined)
    assert.deepEqual(jobs, [{ action: 'record', out: '/t/a.mp4', seconds: 120, mode: 0o600 }])
    assert.deepEqual(await screen.stop(), { file: '/t/a.mp4', seconds: 42 })
  })
  test('only one recording runs at a time, and stop with none running says so', async () => {
    const { screen } = setup()
    assert.deepEqual(await screen.stop(), { error: 'nothing is recording' })
    await screen.start('/t/a.mp4', 60)
    assert.match(await screen.start('/t/b.mp4', 60) ?? '', /already recording/)
    await screen.stop()
    assert.equal(await screen.start('/t/c.mp4', 60), undefined)
  })
  test('a recording that ended at its time limit does not block the next one', async () => {
    const { screen } = setup(() => ['{"state":"saved","seconds":5}'])
    assert.match(await screen.start('/t/a.mp4', 5) ?? '', /ended before it started/)
    assert.equal((await screen.stop() as { error: string }).error, 'nothing is recording')
  })
  test('a picture names only the app asked for, and comes back as saved', async () => {
    const { screen, jobs } = setup(() => ['{"state":"saved"}'])
    assert.equal(await screen.shot('/t/s.png', 'Google Chrome'), undefined)
    assert.deepEqual(jobs, [{ action: 'shot', out: '/t/s.png', app: 'Google Chrome', mode: 0o600 }])
  })
  test("with no screen permission yet, the answer tells the owner where to turn it on", async () => {
    const { screen } = setup(() => ['{"error":"permission"}'])
    assert.match(await screen.shot('/t/s.png') ?? '', /Kage Screen in System Settings > Privacy & Security > Screen & System Audio Recording/)
    assert.match(await screen.start('/t/a.mp4', 60) ?? '', /System Settings/)
  })
  test("the helper's own error comes back as it said it", async () => {
    const { screen } = setup(() => ['{"error":"no running app named Nope"}'])
    assert.equal(await screen.shot('/t/s.png', 'Nope'), 'Kage Screen: no running app named Nope')
  })
  test('the app is built inside the screen folder before each launch', async () => {
    const built: string[] = []
    const { dir, screen } = setup(() => ['{"state":"saved"}'], built)
    await screen.shot('/t/s.png')
    assert.deepEqual(built, [`${dir}/Kage Screen.app`])
  })
})
