// The repo's structure rules (ADR 0014). Each rule lists today's debt by name. A new break fails, and so does a
// debt entry that is fixed but still listed, so the lists only shrink. Never add to a debt list: fix the code.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'

const root = new URL('..', import.meta.url).pathname
const files = execFileSync('git', ['ls-files', '*.ts', '*.js'], { cwd: root, encoding: 'utf8' }).split('\n')
  .filter(f => f && !/(^|\/)tests\//.test(f) && !f.startsWith('docs/'))
const text = new Map(files.map(f => [f, readFileSync(`${root}/${f}`, 'utf8')]))
const lines = (f: string) => text.get(f)!.split('\n').length - 1   // as wc -l counts
const inDir = (d: string) => files.filter(f => f.startsWith(`${d}/`) && f.endsWith('.ts') && !f.slice(d.length + 1).includes('/'))

const MAX_LINES = 300

const DEBT = {
  // ADR 0001: core/ does no I/O, reads no environment, sets no timers, and imports only core/.
  impureCore: [
    'core/guards.ts', 'core/transcript.ts', 'core/blocks.ts',
  ] as string[],
  // runtime/ and connectors/ never import a file in the repo root (router.ts, config.ts, ...).
  rootImports: [
    'runtime/closed-threads.ts', 'runtime/jobs.ts', 'runtime/kage-tools.ts',
    'runtime/ledger.ts', 'runtime/scheduler.ts', 'runtime/sdk-sessions.ts',
    'runtime/session-link.ts', 'runtime/slack-files.ts', 'runtime/tmux-panes.ts',
    'connectors/email.ts', 'connectors/github.ts', 'connectors/jev.ts',
    'connectors/meeting.ts', 'connectors/slack-afk.ts', 'connectors/slack-commands.ts',
    'connectors/slack.ts', 'connectors/voice.ts', 'connectors/whatsapp.ts',
  ] as string[],
  // A source file over MAX_LINES lines, with the most it may have. Split it; lower the number as it shrinks.
  longFiles: {
    'runtime/kage-tools.ts': 832, 'router.ts': 728, 'cli/top.ts': 624,
    'runtime/kagelets.ts': 453, 'runtime/sdk-sessions.ts': 347, 'core/sessions.ts': 323,
  } as Record<string, number>,
  // A core/ or runtime/ file missing from the CONTRIBUTING.md code map.
  unmapped: [
    'core/cli-help.ts', 'core/dream.ts', 'core/github.ts',
    'core/kagelet-memory.ts', 'core/log-repeats.ts', 'core/meeting.ts',
    'core/quiet.ts', 'core/retro.ts', 'core/settings.ts',
    'core/skill-lessons.ts', 'core/socket-watch.ts', 'runtime/config-watch.ts',
    'runtime/hold-keys.ts', 'runtime/jobs.ts', 'runtime/kagelet-memory.ts',
    'runtime/key-proxy.ts', 'runtime/memory-snapshot.ts', 'runtime/repo-access.ts',
  ] as string[],
  // A core/ export no other source file uses. Tests do not count: un-export it, or delete it with its test.
  unusedCoreExports: [
    'core/access.ts Verb', 'core/afk.ts Ping', 'core/afk.ts CALL_GAP', 'core/afk.ts BURST',
    'core/afk.ts AfkAction', 'core/auto-update.ts Gate', 'core/blocks.ts OWNER_BLOCKED', 'core/blocks.ts BlockPlan',
    'core/board.ts Known', 'core/browser-act.ts ActContext', 'core/cli-help.ts suggest', 'core/commands.ts CommandResult',
    'core/config.ts agentLine', 'core/config.ts ALIASES', 'core/config.ts NOT_SETTINGS', 'core/config.ts toEnv',
    'core/cron.ts cronMatches', 'core/doctor.ts nodeOk', 'core/email.ts MailTask', 'core/email.ts newPart',
    'core/events.ts dayEvents', 'core/events.ts ChainView', 'core/gate.ts Trigger', 'core/gate.ts Drop',
    'core/github.ts GithubEvent', 'core/jev.ts JEV_MAX_CHARS', 'core/jev.ts QUESTION', 'core/jev.ts OTHER_BAR',
    'core/jev.ts OWNER_BAR', 'core/jev.ts TRIAGE_MAX_CHARS', 'core/jev.ts AFK_P0_BAR', 'core/kagelet-message.ts Part',
    'core/kagelets.ts Maker', 'core/loom.ts Tone', 'core/meeting.ts MAX_TRANSCRIPT', 'core/outbound.ts CODE_WIDTH',
    'core/registry.ts validAppId', 'core/release.ts Bump', 'core/release.ts bumpVersion', 'core/sessions.ts Unquiet',
    'core/slack-files.ts MAX_FILES', 'core/socket-watch.ts SocketVerdict', 'core/ssm.ts Relay', 'core/whatsapp.ts WaMessage',
    'core/whatsapp.ts WaAction', 'core/whatsapp.ts MAX_STAND_IN_REPLIES', 'core/whatsapp.ts hasTag',
  ] as string[],
}

function check(name: string, found: string[], debt: string[]) {
  const added = found.filter(x => !debt.includes(x)), fixed = debt.filter(x => !found.includes(x))
  assert.deepEqual(added, [], `${name}: new breaks. Fix them; never add to the debt list in tests/structure.test.ts`)
  assert.deepEqual(fixed, [], `${name}: fixed, so remove these from the debt list in tests/structure.test.ts`)
}

test('core/ is pure: no I/O, no environment, no timers, and imports only core/ (ADR 0001)', () => {
  const bad = /from '(node:)?(fs|child_process|net|http|https|os|dgram|tls)(\/promises)?'|process\.env|\bset(Timeout|Interval)\(|from '\.\.\//
  check('impureCore', inDir('core').filter(f => bad.test(text.get(f)!)), DEBT.impureCore)
})

test('runtime/ and connectors/ never import a root file', () => {
  const bad = /from '\.\.\/[^/']+'/
  check('rootImports', [...inDir('runtime'), ...inDir('connectors')].filter(f => bad.test(text.get(f)!)), DEBT.rootImports)
})

test(`a source file is ${MAX_LINES} lines or fewer, and a long one never grows`, () => {
  const long = files.filter(f => lines(f) > MAX_LINES)
  check('longFiles', long, Object.keys(DEBT.longFiles))
  const grew = long.filter(f => lines(f) > DEBT.longFiles[f]!).map(f => `${f}: ${lines(f)} > ${DEBT.longFiles[f]}`)
  assert.deepEqual(grew, [], 'longFiles: these grew. Split them instead')
})

test('every core/ and runtime/ file is in the CONTRIBUTING.md code map', () => {
  const map = readFileSync(`${root}/CONTRIBUTING.md`, 'utf8')
  check('unmapped', [...inDir('core'), ...inDir('runtime')].filter(f => !map.includes(`\`${basename(f)}\``)), DEBT.unmapped)
})

test('every core/ export is used by another source file', () => {
  const unused: string[] = []
  for (const f of inDir('core')) for (const [, name] of text.get(f)!.matchAll(/^export (?:async )?(?:function\*?|const|let|class|type|interface) (\w+)/gm)) {
    const word = new RegExp(`\\b${name}\\b`)
    if (!files.some(g => g !== f && word.test(text.get(g)!))) unused.push(`${f} ${name}`)
  }
  check('unusedCoreExports', unused, DEBT.unusedCoreExports)
})

test('code marked "compat: remove after <date>" is gone by that date', () => {
  const today = new Date().toISOString().slice(0, 10)
  const due = files.flatMap(f => [...text.get(f)!.matchAll(/compat: remove after (\d{4}-\d{2}-\d{2})/g)].filter(m => m[1]! < today).map(m => `${f} (${m[1]})`))
  assert.deepEqual(due, [], 'past their removal date: delete the compat code')
})
