import { test } from 'node:test'
import assert from 'node:assert/strict'
import { crashLooping, cwdsFromLsof, elapsedSeconds, leftoverLines, leftoverProcess, leftoversLine, startedAt, type Container, type Proc } from '../leftovers.ts'

const proc = (o: Partial<Proc>): Proc => ({ pid: 4242, cpu: 0.5, ageSec: 60, cwdGone: false, command: 'node hub.ts', ...o })
const box = (o: Partial<Container>): Container => ({ engine: 'docker', name: 'api', restarts: 0, startedSec: 86_400, restarting: false, ...o })

test('a process whose working folder is gone is a leftover, at any age', () => {
  assert.equal(leftoverProcess(proc({ cwdGone: true, ageSec: 5 })), 'its folder is gone')
})

test('a node --test run older than 10 minutes is a leftover, and a younger one is not', () => {
  assert.equal(leftoverProcess(proc({ command: 'node --test runtime/tests/a.test.ts', ageSec: 601 })), 'a test run older than 10 minutes')
  assert.equal(leftoverProcess(proc({ command: 'node --test runtime/tests/a.test.ts', ageSec: 600 })), undefined)
  assert.equal(leftoverProcess(proc({ command: '/usr/local/bin/node --experimental-strip-types --test x.test.ts', ageSec: 7200 })), 'a test run older than 10 minutes')
})

test('a long-lived process in a folder that still exists is not a leftover', () => {
  assert.equal(leftoverProcess(proc({ command: 'node hub.ts', ageSec: 999_999 })), undefined)
  assert.equal(leftoverProcess(proc({ command: 'vim notes-about-node --test.md', ageSec: 999_999 })), undefined)
})

test('a container the restart policy restarted within the hour is crash-looping, and one restarted long ago is not', () => {
  assert.equal(crashLooping(box({ restarts: 56_772, startedSec: 12 })), true)
  assert.equal(crashLooping(box({ restarting: true })), true)
  assert.equal(crashLooping(box({ restarts: 3, startedSec: 7200 })), false)
  assert.equal(crashLooping(box({ restarts: 0, startedSec: 30 })), false)
})

test('each finding is a note with the PID or name, the numbers and the command that stops it', () => {
  const lines = leftoverLines([proc({ pid: 77, cpu: 112, ageSec: 38 * 3600, cwdGone: true, command: 'node --test core/tests/x.test.ts' })], [box({ engine: 'podman', name: 'db', restarts: 9, startedSec: 40 })], [])
  assert.deepEqual(lines, [
    { kind: 'note', text: 'leftover process 77 (112% CPU, up 38 h): its folder is gone. node --test core/tests/x.test.ts. Stop it: kill 77' },
    { kind: 'note', text: 'container db restarted 9 times, last within the hour: it looks stuck in a crash loop. Stop it: podman stop db' },
  ])
})

test("the doctor's own processes are never listed", () => {
  assert.deepEqual(leftoverLines([proc({ pid: 5, cwdGone: true })], [], [5]), [])
})

test('a long command is cut to one short line', () => {
  const [l] = leftoverLines([proc({ cwdGone: true, command: `node ${'x'.repeat(300)}` })], [], [])
  assert.ok(l!.text.length < 220)
})

test("ps elapsed time reads both Linux etimes seconds and macOS etime's [[dd-]hh:]mm:ss", () => {
  assert.equal(elapsedSeconds('3725'), 3725)
  assert.equal(elapsedSeconds('05:03'), 303)
  assert.equal(elapsedSeconds('02:00:01'), 7201)
  assert.equal(elapsedSeconds('1-02:00:00'), 93_600)
  assert.equal(elapsedSeconds('bad'), 0)
})

test('a test run behind other node flags is found, a watch run and --test-only are not (#276 review)', () => {
  assert.equal(leftoverProcess(proc({ command: 'node --import tsx --test x.test.ts', ageSec: 900 })), 'a test run older than 10 minutes')
  assert.equal(leftoverProcess(proc({ command: 'node --require ./setup.js --test', ageSec: 900 })), 'a test run older than 10 minutes')
  assert.equal(leftoverProcess(proc({ command: 'node --test --watch x.test.ts', ageSec: 900 })), undefined)
  assert.equal(leftoverProcess(proc({ command: 'node --test-only x.test.ts', ageSec: 900 })), undefined)
})

test('the age reads in minutes under an hour and in hours from the hour on', () => {
  const at = (ageSec: number) => leftoverLines([proc({ cwdGone: true, ageSec })], [], [])[0]!.text
  assert.match(at(59 * 60), /up 59 min/)
  assert.match(at(3600), /up 1 h/)
})

test("docker's RFC 3339 start and podman's Go time format read the same instant", () => {
  assert.equal(startedAt('2026-11-20T10:00:00.123456789Z'), Date.parse('2026-11-20T10:00:00.123Z'))
  assert.equal(startedAt('2026-11-20 10:00:00.123456789 +0000 UTC'), Date.parse('2026-11-20T10:00:00.123Z'))
  assert.equal(startedAt('2026-11-20 15:30:00 +0530 IST'), Date.parse('2026-11-20T10:00:00Z'))
  assert.ok(Number.isNaN(startedAt('soon')))
})

test('the kage top line counts one finding as one', () => {
  assert.equal(leftoversLine(1), '1 leftover process or container slows this machine: kage doctor lists it')
  assert.equal(leftoversLine(2), '2 leftover processes or containers slow this machine: kage doctor lists them')
})

test("lsof -Fpn's output gives each process its working folder, as kage doctor reads it on macOS", () => {
  const out = 'p101\nfcwd\nn/Users/someone/projects/kage\np202\nfcwd\nn/private/tmp/gone worktree\np303\nfcwd\n'
  assert.deepEqual([...cwdsFromLsof(out)], [[101, '/Users/someone/projects/kage'], [202, '/private/tmp/gone worktree']])
  assert.deepEqual([...cwdsFromLsof('')], [])
})
