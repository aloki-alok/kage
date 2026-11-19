import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { query } from '@anthropic-ai/claude-agent-sdk'
import { protectConfig } from '../path-guards.ts'
import { sandboxed } from '../../core/guards.ts'

const which = (c: string) => { try { return execFileSync('which', [c], { encoding: 'utf8' }).trim() } catch { return '' } }
const claude = which('claude')
const osSandbox = process.platform === 'darwin' ? existsSync('/usr/bin/sandbox-exec') : !!which('bwrap')
const skip = process.env.KAGE_LIVE_TESTS !== '1' ? 'set KAGE_LIVE_TESTS=1 to run: it calls a real model' : !claude ? 'no claude command' : !osSandbox ? 'no OS sandbox here' : false

async function run(ownerThread: boolean, steps: string[]) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kage-sbt-')))
  const cfg = `${root}/cfg`, code = `${root}/code`, work = `${root}/work`
  for (const d of [cfg, code, work]) mkdirSync(d, { recursive: true })
  writeFileSync(`${cfg}/secrets.json`, '{"slack":{"bot":"xoxb-FAKE-SECRET"}}')
  writeFileSync(`${cfg}/config.json`, '{"version":1}')
  const walls = protectConfig(`${cfg}/env`, code, undefined, sandboxed('teammates', ownerThread))
  const all = [...steps.map(s => s.replaceAll('$ROOT', root).replaceAll('$WORK', work)), `echo done > ${work}/done.txt`]
  const seen: string[] = []
  const q = query({
    prompt: `Run each of these shell commands with its own Bash call, exactly as written, in order, and never stop at a failure:\n${all.map(s => `- ${s}`).join('\n')}`,
    options: {
      cwd: work, model: 'haiku', maxTurns: 20, settingSources: [], pathToClaudeCodeExecutable: claude,
      tools: ['Bash'], permissionMode: 'dontAsk',
      settings: { permissions: { allow: ['Bash'], ...walls.permissions }, ...walls.sandbox && { sandbox: walls.sandbox } } as any,
    },
  })
  for await (const m of q) if (m.type === 'user') for (const c of (m.message.content as any[]) ?? []) if (c.type === 'tool_result') seen.push(typeof c.content === 'string' ? c.content : JSON.stringify(c.content))
  return { out: seen.join('\n'), ran: existsSync(`${work}/done.txt`), work, walled: !!walls.sandbox }
}

test("with harness.sandbox teammates, a teammate's thread cannot read secrets.json with a reworded command (#313)", { skip, timeout: 600_000 }, async () => {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const r = await run(false, ['cd $ROOT && cd c* && cat sec*', 'cat $ROOT/c?g/secrets.js?n', 'F=$ROOT/cfg; F=$F/secr; cat "${F}ets.json"'])
    assert.equal(r.walled, true)
    assert.ok(!r.out.includes('FAKE-SECRET'), 'a token was read')
    if (r.ran) return
  }
  assert.fail('the model never ran the control step in 3 attempts')
})

test("with harness.sandbox teammates, the owner's own thread runs with no OS sandbox and binds a local port (#313)", { skip, timeout: 300_000 }, async () => {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const r = await run(true, [`node -e "require('net').createServer().listen(0,'127.0.0.1',function(){require('fs').writeFileSync('$WORK/port.txt',String(this.address().port));this.close()})"`])
    assert.equal(r.walled, false)
    if (!r.ran) continue
    assert.match(existsSync(`${r.work}/port.txt`) ? readFileSync(`${r.work}/port.txt`, 'utf8') : '', /^\d+$/, 'the owner thread could not bind a port')
    return
  }
  assert.fail('the model never ran the control step in 3 attempts')
})
