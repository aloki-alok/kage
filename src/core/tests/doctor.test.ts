import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { ownerChannelLine, autoUpdateNote, bootNotes, chromeLine, jevLine, keyLines, lingerLine, nodeOk, pathNote, render, report, serviceLines, sessionLines, slackLines, pluginLine, sandboxLine, tokenLines, toolsLine, whatsappLine } from '../doctor.ts'

const text = (ls: { kind: string; text: string }[]) => ls.map(l => `${l.kind}:${l.text}`)

describe('doctor output', () => {
  test('a line renders as ok, FAIL or note, padded to six columns', () => {
    assert.equal(render({ kind: 'ok', text: 'x' }), 'ok    x')
    assert.equal(render({ kind: 'fail', text: 'x' }), 'FAIL  x')
    assert.equal(render({ kind: 'note', text: 'x' }), 'note  x')
  })
  test('the last line is All good only when nothing fails, and notes do not fail', () => {
    const good = report([{ kind: 'ok', text: 'a' }, { kind: 'note', text: 'b' }], 'kage')
    assert.equal(good.ok, true)
    assert.equal(good.text, 'ok    a\nnote  b\nAll good. Tag @kage in Slack to try it.')
    const bad = report([{ kind: 'fail', text: 'a' }], 'kage')
    assert.equal(bad.ok, false)
    assert.equal(bad.text, 'FAIL  a')
  })
})

describe('decisions', () => {
  test('node 22.18 is the floor', () => {
    assert.deepEqual(['22.17.9', '22.18.0', '23.0.0', '21.9.0'].map(nodeOk), [false, true, true, false])
  })
  test('tools: tmux counts only for the tmux runtime', () => {
    const f = { nodeVersion: '22.18.0', claude: true, tmuxNeeded: false, tmux: false }
    assert.equal(toolsLine(f).kind, 'ok')
    assert.equal(toolsLine({ ...f, claude: false }).kind, 'fail')
    assert.equal(toolsLine({ ...f, tmuxNeeded: true }).kind, 'fail')
  })
  test('no settings is one FAIL that names the folder', () => {
    assert.deepEqual(text(tokenLines({ hasSettings: false, dir: '/c', mode: undefined, slack: {} })), ['fail:tokens: no settings in /c. Run kage app, then kage save'])
  })
  test('tokens: a loose file mode and a rejected token each fail', () => {
    const ls = tokenLines({ hasSettings: true, dir: '/c', file: '/c/secrets.json', mode: '644', slack: { app: true, user: false, bot: true } })
    assert.deepEqual(text(ls), [
      'fail:token file: run chmod 600 /c/secrets.json',
      'ok:SLACK_APP_TOKEN accepted by Slack',
      'fail:SLACK_USER_TOKEN: missing or rejected. Run kage save again',
      'ok:SLACK_BOT_TOKEN accepted by Slack',
    ])
  })
  test('jev: silent when off, its line when it works, a fail when it exits non-zero', () => {
    assert.equal(jevLine({ status: 0, out: '' }), undefined)
    assert.deepEqual(jevLine({ status: 0, out: 'jevKey accepted' }), { kind: 'ok', text: 'jevKey accepted' })
    assert.deepEqual(jevLine({ status: 1, out: 'jev: bad' }), { kind: 'fail', text: 'jev: bad' })
    assert.deepEqual(jevLine({ status: 1, out: '' }), { kind: 'fail', text: 'jev: the check did not run' })
  })
  test('sandbox: sandbox-exec on a Mac, bubblewrap and socat on Linux', () => {
    assert.equal(sandboxLine({ on: false, platform: 'linux', sandboxExec: false, bwrap: false, socat: false }).kind, 'ok', 'off: a missing sandbox blocks nothing')
    assert.equal(sandboxLine({ on: true, platform: 'darwin', sandboxExec: true, bwrap: false, socat: false }).kind, 'ok')
    assert.equal(sandboxLine({ on: true, platform: 'darwin', sandboxExec: false, bwrap: true, socat: true }).kind, 'fail')
    assert.equal(sandboxLine({ on: true, platform: 'linux', sandboxExec: false, bwrap: true, socat: false }).kind, 'fail')
    assert.equal(sandboxLine({ on: true, platform: 'linux', sandboxExec: false, bwrap: true, socat: true }).kind, 'ok')
  })
  test('session keys: one ok line per key, with its name, host and header, and no value', () => {
    const lines = keyLines({ API_KEY: { host: 'api.example.test', header: 'x-api-key', value: 'fake-secret' } as never, TOKEN_B: { host: 'b.example.test' } })
    assert.equal(lines.length, 2)
    assert.match(lines[0]!.text, /API_KEY.*api\.example\.test.*x-api-key/)
    assert.match(lines[1]!.text, /TOKEN_B.*b\.example\.test.*authorization/)
    assert.ok(!lines.some(l => l.text.includes('fake-secret')))
    assert.deepEqual(keyLines(undefined), [])
  })
  test('ssm plugin: on the hub PATH is an ok, missing is a note that says what stops working', () => {
    assert.equal(pluginLine(true).kind, 'ok')
    const n = pluginLine(false)
    assert.equal(n.kind, 'note')
    assert.match(n.text, /session-manager-plugin/)
  })
  test('session: SDK must load; tmux plugin route needs plugin and org approval; dev route is a note', () => {
    assert.deepEqual(text(sessionLines({ runtime: 'sdk', sdkLoads: true })), ['ok:threads run on the Agent SDK, no prompts'])
    assert.equal(sessionLines({ runtime: undefined, sdkLoads: false })[0]!.kind, 'fail')
    assert.deepEqual(sessionLines({ runtime: 'tmux', route: 'plugin', plugin: true, orgApproved: false }).map(l => l.kind), ['ok', 'fail'])
    assert.deepEqual(sessionLines({ runtime: 'tmux', route: 'plugin', plugin: false, orgApproved: true }).map(l => l.kind), ['fail', 'ok'])
    assert.deepEqual(sessionLines({ runtime: 'tmux' }).map(l => l.kind), ['note'])
  })
  test('service: running, stopped, stale unit, old tmux, off', () => {
    const f = { name: 'kage', installed: true, running: true, stale: false, oldTmux: false }
    assert.deepEqual(text(serviceLines(f)), ['ok:the service keeps kage running'])
    assert.deepEqual(text(serviceLines({ ...f, running: false })), ['fail:the service is on but kage is stopped: kage start'])
    assert.deepEqual(text(serviceLines({ ...f, stale: true })), ['ok:the service keeps kage running', 'fail:the service unit still pins KAGE_CWD, so harness.cwd would not apply: kage service on'])
    assert.equal(serviceLines({ ...f, installed: false, oldTmux: true })[0]!.text, 'kage runs in tmux, which does not bring it back after a reboot or a kill: kage service on')
    assert.equal(serviceLines({ ...f, installed: false })[0]!.text, 'not running: kage start')
  })
  test('linger: only systemd without linger fails', () => {
    assert.equal(lingerLine({ kind: 'systemd', linger: 'no', user: 'u' })?.text, 'it starts only once you log in: sudo loginctl enable-linger u')
    assert.equal(lingerLine({ kind: 'systemd', linger: 'yes', user: 'u' }), undefined)
    assert.equal(lingerLine({ kind: 'launchd', linger: '', user: 'u' }), undefined)
  })
  test('boots: a missing file is zero boots (#90); planned starts say nothing, however many; crashes and unknown stops are named (#255)', () => {
    assert.deepEqual(bootNotes({ boots: undefined, now: 100_000, darwin: false }), [])
    const planned = [...Array.from({ length: 29 }, (_, i) => `${99_000 + i} update`), ...Array.from({ length: 33 }, (_, i) => `${99_100 + i} restart`), '10000 crash old'].join('\n')
    assert.deepEqual(bootNotes({ boots: planned, now: 100_000, darwin: false }), [])
    assert.deepEqual(text(bootNotes({ boots: '99001 crash TypeError: x is undefined\n99002 crash RangeError: too deep\n99003 unknown\n', now: 100_000, darwin: false })), [
      'note:the hub crashed 2 times in 24 h. The last one: RangeError: too deep. kage logs has the full error',
      'note:the hub stopped once in 24 h without saying why (killed, out of memory, or power lost). kage logs shows what ran before it',
    ])
    assert.deepEqual(text(bootNotes({ boots: undefined, now: 1, darwin: true })), ['note:with the lid closed this Mac sleeps, and Kage is offline until it wakes'])
  })
  test('slack: connected shows the status and version, else one FAIL', () => {
    assert.deepEqual(text(slackLines({ connected: true, status: 'connected 1 pid 2', version: 'abc (2026-01-01)' })), ['ok:connected to Slack: connected 1 pid 2', 'ok:runs Kage abc (2026-01-01)'])
    assert.deepEqual(text(slackLines({ connected: false, status: '', version: 'unknown' })), ['fail:not connected to Slack yet: wait 20 s after start, or run kage logs to see why'])
  })
  test('auto-update: each reason in order, then ask origin, then the stable-tag cases', () => {
    const base = { off: false, git: true, branch: 'main', dirty: false }
    assert.equal((autoUpdateNote({ ...base, off: true }) as { text: string }).text, 'auto-update is off (autoUpdate is false)')
    assert.equal((autoUpdateNote({ ...base, git: false }) as { text: string }).text, 'no auto-update: not a git checkout. Rerun the install line to make it one')
    assert.equal((autoUpdateNote({ ...base, branch: 'x' }) as { text: string }).text, 'no auto-update: on branch x, not main')
    assert.equal((autoUpdateNote({ ...base, dirty: true }) as { text: string }).text, 'no auto-update: the checkout has uncommitted changes')
    assert.equal(autoUpdateNote(base), 'ask-origin')
    assert.equal((autoUpdateNote({ ...base, origin: 'failed' }) as { text: string }).text, 'auto-update cannot check origin: git ls-remote failed')
    assert.equal((autoUpdateNote({ ...base, origin: 'no-stable' }) as { text: string }).text, 'no auto-update: origin has no stable tag yet, so this install stays on its version')
    assert.equal(autoUpdateNote({ ...base, origin: 'stable' }), undefined)
    assert.match((autoUpdateNote({ ...base, origin: 'diverged' }) as { text: string }).text, /stuck: the stable tag is not on this checkout's history/)
  })
  test('chrome: connected only while the last poll is newer than the stale time the browser tools use (#528)', () => {
    assert.equal(chromeLine(1_000_000_000_000 - 59_000, 1_000_000_000, 60_000).kind, 'ok')
    assert.equal(chromeLine(1_000_000_000_000 - 61_000, 1_000_000_000, 60_000).kind, 'fail')
    assert.equal(chromeLine(0, 1_000_000_000, 60_000).kind, 'fail')
    assert.doesNotMatch((chromeLine(0, 1_000_000_000, 60_000) as { text: string }).text, /paste|prints a new one/)
  })
  test('chrome: names the version it runs, and fails when the folder holds a newer one', () => {
    const now = 1_000_000_000, seen = now * 1000
    assert.equal((chromeLine(seen, now, 60_000, '0.4.1', '0.4.1') as { text: string }).text, 'Chrome extension connected (v0.4.1)')
    const old = chromeLine(seen, now, 60_000, '0.4.0', '0.4.1') as { kind: string; text: string }
    assert.equal(old.kind, 'fail')
    assert.match(old.text, /runs v0\.4\.0.*v0\.4\.1.*chrome:\/\/extensions/)
    assert.equal(chromeLine(seen, now, 60_000, undefined, '0.4.1').kind, 'fail')
  })
  test('path note only when kage is not on PATH', () => {
    assert.equal(pathNote(true), undefined)
    assert.equal(pathNote(false)?.kind, 'note')
  })
  test('whatsapp: ok for a WORKING session, else FAIL with the fix', () => {
    const at = { url: 'http://127.0.0.1:3198', qr: '/kage/waha/qr.sh' }
    assert.deepEqual(whatsappLine({ reached: true, code: 200, status: 'WORKING' }, at), { kind: 'ok', text: 'WhatsApp bridge up, session WORKING' })
    const down = whatsappLine({ reached: false }, at)
    assert.equal(down.kind, 'fail')
    assert.match(down.text, /docker start kage-waha/)
  })
  test('owner channel: nothing for Slack, a note that cards stay in Slack for WhatsApp, a FAIL when WhatsApp is chosen but off (#423)', () => {
    assert.equal(ownerChannelLine(undefined, true), undefined)
    assert.equal(ownerChannelLine('slack', false), undefined)
    const on = ownerChannelLine('whatsapp', true)!
    assert.equal(on.kind, 'note')
    assert.match(on.text, /approval cards go to your WhatsApp/)
    const off = ownerChannelLine('whatsapp', false)!
    assert.equal(off.kind, 'fail')
    assert.match(off.text, /kage set owner.channel slack/)
  })
})
