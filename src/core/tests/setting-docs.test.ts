import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { keyHelp, settingDocs, settingsOverview } from '../setting-docs.ts'

const MD = `# Settings

## Sessions

| Setting | Default | Effect |
|---|---|---|
| \`claudeToken\` | your own Claude login | secrets.json. Kage's own Claude login. |
| \`harness.maxSessions\` | \`4\` | Sessions that run at once. A tag over the limit gets ⏳. |
| \`harness.leanSessions\` | \`on\` | A thread you did not start skips your own Claude Code setup: your \`~/.claude/CLAUDE.md\`. It keeps your model. |

## Kagelets

| Setting | Default | Effect |
|---|---|---|
| \`kagelets.turnStallMinutes\`, \`kagelets.incidentsPerHour\` | \`20\`, \`5\` | A stalled run is cut. |
`

test('each documented key with its section, default and effect; secrets are left out (#settings)', () => {
  const docs = settingDocs(MD)
  assert.deepEqual(docs.map(d => [d.key, d.section, d.default]), [
    ['harness.maxSessions', 'Sessions', '4'], ['harness.leanSessions', 'Sessions', 'on'],
    ['kagelets.turnStallMinutes', 'Kagelets', '20, 5'], ['kagelets.incidentsPerHour', 'Kagelets', '20, 5'],
  ])
  assert.equal(docs[1]!.effect, 'A thread you did not start skips your own Claude Code setup: your ~/.claude/CLAUDE.md. It keeps your model.')
})

test('kage set alone lists every key by section with its value when set, and its first sentence', () => {
  const lines = settingsOverview(settingDocs(MD), k => k === 'harness.maxSessions' ? 6 : undefined)
  assert.deepEqual(lines, [
    'Sessions',
    '  harness.maxSessions   6 (default 4)  Sessions that run at once.',
    '  harness.leanSessions  on             A thread you did not start skips your own Claude Code setup: your ~/.claude/CLAUDE.md.',
    '',
    'Kagelets',
    '  kagelets.turnStallMinutes  20, 5  A stalled run is cut.',
    '  kagelets.incidentsPerHour  20, 5  A stalled run is cut.',
    '',
    'kage set <key> shows one in full. Every setting: docs/settings.md',
  ])
})

test('kage set <key> explains it; a typo gets the closest key', () => {
  const docs = settingDocs(MD)
  assert.deepEqual(keyHelp(docs, 'harness.leanSessions', false), [
    'harness.leanSessions = false (default on)',
    'A thread you did not start skips your own Claude Code setup: your ~/.claude/CLAUDE.md. It keeps your model.',
    'Change it: kage set harness.leanSessions <value>',
  ])
  assert.deepEqual(keyHelp(docs, 'harness.maxSessions', undefined)[0], 'harness.maxSessions is not set, so it is 4')
  assert.deepEqual(keyHelp(docs, 'harness.leanSesions', undefined), ['No setting harness.leanSesions. Did you mean harness.leanSessions?'])
  assert.deepEqual(keyHelp(docs, 'nothing.like.it', undefined), ['No setting nothing.like.it. kage set lists them all.'])
})

test('the real docs give every key a default and an effect', () => {
  const docs = settingDocs(readFileSync(new URL('../../../docs/settings.md', import.meta.url), 'utf8'))
  assert.ok(docs.length > 80, String(docs.length))
  assert.deepEqual(docs.filter(d => !d.default || !d.effect).map(d => d.key), [])
})
