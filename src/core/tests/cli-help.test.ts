import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { suggest } from '../cli-help.ts'

describe('every command kage lists is one it runs, and the other way', () => {
  const sh = readFileSync(new URL('../../../setup.sh', import.meta.url), 'utf8')
  const table = /COMMANDS='([\s\S]*?)'/.exec(sh)![1]!.split('\n').map(l => l.split('|')[1]!)
  const renamed = new Map(/RENAMED='([\s\S]*?)'/.exec(sh)![1]!.split('\n').map(l => l.split('|') as [string, string]))
  const main = sh.slice(sh.lastIndexOf('case "${1:-}" in'))
  const blocks = new Map([...main.matchAll(/^  ([a-z-]+)\)([\s\S]*?)(?=^  [a-z-]+\)|^esac)/gm)].map(m => [m[1]!, m[2]!]))
  const verbsOf = (noun: string) => [...(blocks.get(noun) ?? '').matchAll(/^ {6}([a-z|-]+)\)/gm)].flatMap(m => m[1]!.split('|'))
  const notListed = new Set(['help', 'export-crons', 'check', 'link'])
  test('each top-level command in the help table has a case, and each case is in the table', () => {
    assert.deepEqual([...new Set(table.map(n => n.split(' ')[0]!))].sort(), [...blocks.keys()].filter(c => !notListed.has(c)).sort())
  })
  test('each noun verb in the help table is a verb its noun runs, and each verb a noun runs is in the table', () => {
    for (const noun of new Set(table.filter(n => n.includes(' ')).map(n => n.split(' ')[0]!))) {
      assert.deepEqual(table.filter(n => n.startsWith(`${noun} `)).map(n => n.split(' ')[1]!).sort(), verbsOf(noun).sort(), noun)
    }
  })
  test('an old name is never a command of its own, and points at a command the table lists', () => {
    for (const [old, now] of renamed) {
      assert.ok(!blocks.has(old), `${old} still has its own case`)
      assert.ok(table.includes(now), `${old} points at ${now}, which the table does not list`)
    }
  })
})

describe('kage <noun> <verb> runs, and an old name says its new one', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kage-cli-'))
  writeFileSync(join(dir, 'config.json'), '{"version":1}')
  const kage = (...args: string[]) => spawnSync('bash', [new URL('../../../setup.sh', import.meta.url).pathname, ...args], { encoding: 'utf8', env: { ...process.env, KAGE_ENV: join(dir, 'env'), NO_COLOR: '1', KAGE_CLAUDE: '' } })
  test('a group with no verb, or a verb with no target, is bad usage: exit 2 and the verbs it takes', () => {
    const bare = kage('thread')
    assert.equal(bare.status, 2)
    assert.match(bare.stderr, /kage thread takes follow, attach, send, stop\./)
    assert.equal(kage('thread', 'stop').status, 2)
    assert.equal(kage('kagelet', 'logs').status, 2)
  })
  test('an old name runs the new command and says the new name on stderr only', () => {
    const r = kage('schedules')
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stderr, /kage schedules is now kage schedule list\./)
    assert.doesNotMatch(r.stdout, /is now/)
  })
  test('help on an old name shows the new command', () => {
    assert.match(kage('attach', '--help').stdout, /^kage thread attach /m)
    assert.match(kage('help', 'tell').stdout, /^kage thread send /m)
  })
  test('a command that needs the hub exits 3 when Kage is not running, with the line on stderr', () => {
    for (const args of [['thread', 'send', 'dm', 'hi'], ['thread', 'stop', 'dm'], ['relay', 'list'], ['trust', 'list']]) {
      const r = kage(...args)
      assert.equal(r.status, 3, `${args.join(' ')}: ${r.stderr}`)
      assert.match(r.stderr, /I'm not running\. Start me with kage start\./)
      assert.equal(r.stdout, '')
    }
  })
  test('the old one-word forms for a thread or kagelet say their new name', () => {
    assert.match(kage('logs', 'triage').stderr, /kage logs <kagelet> is now kage kagelet logs <kagelet>\./)
    assert.match(kage('start', 'triage').stderr, /kage start <kagelet> is now kage kagelet start <kagelet>\./)
    assert.match(kage('stop', 'triage').stderr, /kage stop <thread or kagelet> is now kage thread stop or kage kagelet stop\./)
  })
  test('check and link are no longer listed: doctor names a missing tool, and setup puts kage on the PATH', () => {
    const help = kage('help').stdout
    assert.doesNotMatch(help, /^  check\b|^  link\b/m)
    const check = kage('check')
    assert.doesNotMatch(check.stderr, /No command/)
    assert.ok(check.status === 0 || /Node|Claude Code/.test(check.stderr), check.stderr)
  })
  test('kage completion bash completes groups and their verbs from the help table', () => {
    const script = kage('completion', 'bash').stdout
    const complete = (...words: string[]) => spawnSync('bash', ['-uc', `${script}\nCOMP_WORDS=(${words.map(w => `'${w}'`).join(' ')}); COMP_CWORD=${words.length - 1}; _kage; printf '%s\\n' "\${COMPREPLY[@]}"`], { encoding: 'utf8' }).stdout.trim().split('\n')
    assert.deepEqual(complete('kage', 'thr'), ['thread'])
    assert.deepEqual(complete('kage', 'thread', '').sort(), ['attach', 'follow', 'send', 'stop'])
    assert.ok(complete('kage', '').includes('doctor'))
  })
  test('kage completion zsh and fish print their scripts, and anything else is bad usage', () => {
    assert.match(kage('completion', 'zsh').stdout, /bashcompinit/)
    assert.match(kage('completion', 'fish').stdout, /complete -c kage -f -n "__fish_seen_subcommand_from thread" -a "follow attach send stop"/)
    assert.equal(kage('completion', 'tcsh').status, 2)
  })
  test('kagelet stop never falls through to a thread', () => {
    const r = kage('kagelet', 'stop', 'nosuch')
    assert.equal(r.status, 1)
    assert.match(r.stderr, /There is no kagelet named "nosuch"/)
  })
})

describe('a mistyped command gets the closest real one', () => {
  const names = ['attach', 'start', 'stop', 'status', 'doctor', 'watch', 'top', 'remove']
  test('one or two letters off finds it', () => {
    assert.equal(suggest('atach', names), 'attach')
    assert.equal(suggest('docter', names), 'doctor')
    assert.equal(suggest('stats', names), 'status')
    assert.equal(suggest('stauts', names), 'status')
    assert.equal(suggest('dcotor', names), 'doctor')
  })
  test('a start of a name finds the one name it starts', () => {
    assert.equal(suggest('rem', names), 'remove')
    assert.equal(suggest('doc', names), 'doctor')
  })
  test('nothing close gives nothing, rather than a wild guess', () => {
    assert.equal(suggest('deploy', names), undefined)
  })
  test('a start shared by several names is no answer', () => {
    assert.equal(suggest('st', names), undefined)
  })
})
