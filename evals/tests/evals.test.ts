import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { refuseLiveConfig } from '../harness.ts'
import { score } from '../score.ts'

test('an eval refuses to run against the live Kage config, even through a link', () => {
  const home = mkdtempSync(join(tmpdir(), 'kage-home-'))
  mkdirSync(join(home, '.config/kage/sub'), { recursive: true })
  assert.throws(() => refuseLiveConfig(join(home, '.config/kage'), home), /refused/)
  assert.throws(() => refuseLiveConfig(join(home, '.config/kage/sub'), home), /refused/)
  const link = join(home, 'link')
  symlinkSync(join(home, '.config/kage'), link)
  assert.throws(() => refuseLiveConfig(link, home), /refused/)
  assert.doesNotThrow(() => refuseLiveConfig(join(home, 'elsewhere'), home))
})

test('the scorer names a missing, extra or wrong task, DM or tool result, and passes an exact match', () => {
  const ev = { tasks: [{ key: 'C1:1.1', text: 'Late: due at 09:00\nScheduled run' }], dms: ['Kagelet *a* failed'], calls: ['refused: only the owner'] }
  assert.deepEqual(score(ev, { tasks: [{ key: 'C1:1.1', match: '^Late' }], dms: ['failed'], calls: ['^refused'] }), [])
  assert.match(score(ev, { tasks: [] }).join(), /task: 1 seen, 0 expected/)
  assert.match(score(ev, { tasks: [{ key: 'C2:2.2', match: '^Late' }] }).join(), /task 1: C1:1\.1/)
  assert.match(score(ev, { dms: [] }).join(), /dm: 1 seen, 0 expected/)
  assert.match(score(ev, { calls: ['^Set'] }).join(), /call 1: refused/)
  assert.deepEqual(score(ev, {}), [])
})
