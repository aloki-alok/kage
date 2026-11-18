import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const runner = new URL('../run.ts', import.meta.url).pathname
function doctor(files: Record<string, string> = {}) {
  const home = mkdtempSync(join(tmpdir(), 'kage-doctor-'))
  const dir = join(home, '.config', 'kage')
  mkdirSync(dir, { recursive: true })
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body)
  const r = spawnSync('node', [runner], { encoding: 'utf8', env: { PATH: process.env.PATH!, HOME: home, KAGE_ENV: join(dir, 'env'), TMUX_TMPDIR: home } })
  return { dir, status: r.status, lines: r.stdout.split('\n').filter(Boolean) }
}

test('a fresh install with no boots file runs every check and fails with its fixes (#90)', () => {
  const { dir, status, lines } = doctor()
  assert.equal(status, 1)
  assert.ok(lines.every(l => /^(ok {4}|FAIL {2}|note {2})/.test(l)), lines.join('\n'))
  assert.ok(lines.includes(`FAIL  tokens: no settings in ${dir}. Run kage app, then kage save`))
  assert.ok(lines.includes('FAIL  not running: kage start'))
  assert.ok(lines.at(-1)!.startsWith('FAIL  not connected to Slack yet') || lines.some(l => l.startsWith('FAIL  not connected to Slack yet')), 'the last checks ran')
  assert.ok(!lines.some(l => l.startsWith('All good')))
})

test('a boots file with more than five starts in a day adds the note', () => {
  const now = Math.floor(Date.now() / 1000)
  const { lines } = doctor({ boots: [1, 2, 3, 4, 5, 6].map(n => now - n).join('\n') + '\n' })
  assert.ok(lines.includes('note  the hub started 6 times in 24 h: kage logs shows why'), lines.join('\n'))
})

test('a stale status file whose pid is gone is not connected', () => {
  const { lines } = doctor({ status: 'connected 2026-01-01T00:00:00Z pid 999999 as @kage\n' })
  assert.ok(lines.some(l => l.startsWith('FAIL  not connected to Slack yet')))
})
