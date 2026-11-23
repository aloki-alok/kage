import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { EventKind, KageEvent } from '../events.ts'
import { bootWhy, crashFingerprint, errorCode, planDetail, sessionTelemetryEnv, TELEMETRY_URL, telemetryEndpoint, toTelemetry } from '../telemetry.ts'

const KINDS: EventKind[] = ['run.start', 'run.end', 'tool', 'handoff', 'grant', 'refusal', 'revoke', 'owner-note', 'report', 'cap-pause', 'cost-flag', 'config.live', 'config.restart', 'config.refused', 'memory-proposal', 'memory-decision', 'day-summary', 'triage', 'tripwire', 'crash', 'limit', 'plan', 'objective', 'boot', 'error', 'shape']
const PLANTED = ['Priya', 'U0TESTUSER1', 'C0TESTCHAN1', 'priya@acme.com', '/Users/priya', 'refund the customer', 'sk-live-123', 'acme']
const ev = (kind: EventKind, detail: string): KageEvent =>
  ({ at: '2026-11-16T10:00:00.000Z', kind, who: 'C0TESTCHAN1:1700000000.000100', trace: 'U0TESTUSER1-t1', chain: 'acme-chain', detail, transcript: '/Users/priya/t.jsonl' })

test('priority zero: no planted name, id, email, path or text leaves, for any kind and any detail', () => {
  const details = [PLANTED.join(' '), `$0.12, ${PLANTED.join(' ')}`, `tick job=${PLANTED[1]} outcome=same ms=40 note=${PLANTED[5]}`, `scheduled ${PLANTED[0]}`, `ok ${PLANTED[3]}`, `${PLANTED[6]} refused: ${PLANTED[5]}`]
  for (const kind of KINDS) for (const d of details) {
    const out = JSON.stringify(toTelemetry(ev(kind, d)) ?? {})
    for (const p of PLANTED) assert.ok(!out.toLowerCase().includes(p.toLowerCase()), `${kind} leaked "${p}" from "${d}": ${out}`)
  }
})

test('every string value that leaves is a fixed word, every other value a finite number', () => {
  for (const kind of KINDS) for (const d of ['$0.12, no report', 'tick job=a1 outcome=changed ms=40', 'task from x', 'browser_tabs new refused: no', 'needs approval', 'deadbeefcafe']) {
    const r = toTelemetry(ev(kind, d))
    if (!r) continue
    for (const [k, v] of Object.entries(r.attrs)) {
      if (typeof v === 'number') assert.ok(Number.isFinite(v), `${kind}.${k}`)
      else assert.match(v, /^[a-z0-9._]{1,16}$/, `${kind}.${k}=${v}`)
    }
  }
})

test('the known shapes give their counts and codes', () => {
  assert.deepEqual(toTelemetry(ev('run.end', '$0.19, no report'))?.attrs, { cost_usd: 0.19, report: 'no' })
  assert.deepEqual(toTelemetry(ev('run.end', '$1.05, reported'))?.attrs, { cost_usd: 1.05, report: 'yes' })
  assert.deepEqual(toTelemetry(ev('run.end', '$0.19, no report, ms=30000 first_post_ms=4200'))?.attrs, { cost_usd: 0.19, report: 'no', ms: 30000, first_post_ms: 4200 })
  assert.deepEqual(toTelemetry(ev('boot', 'update'))?.attrs, { why: 'update' })
  assert.deepEqual(toTelemetry(ev('boot', 'Priya'))?.attrs, { why: 'other' })
  assert.deepEqual(toTelemetry(ev('error', 'post_failed'))?.attrs, { code: 'post_failed' })
  assert.deepEqual(toTelemetry(ev('error', 'Priya failed'))?.attrs, { code: 'other' })
  assert.deepEqual(toTelemetry(ev('shape', 'email=1 voice=0 schedules=11 tripwires=3 priya=5'))?.attrs, { email: 1, voice: 0, schedules: 11, tripwires: 3 })
  assert.deepEqual(toTelemetry(ev('run.start', 'scheduled 93af72f6'))?.attrs, { trigger: 'scheduled' })
  assert.deepEqual(toTelemetry(ev('run.start', 'Priya asked for x'))?.attrs, { trigger: 'other' })
  assert.deepEqual(toTelemetry(ev('run.start', 'task from the teammate'))?.attrs, { trigger: 'task', from: 'teammate' })
  assert.deepEqual(toTelemetry(ev('run.start', 'task from the owner'))?.attrs, { trigger: 'task', from: 'owner' })
  assert.deepEqual(toTelemetry(ev('limit', 'rate_limit window=seven_day wait_s=360000 held=2'))?.attrs, { kind: 'rate_limit', window: 'seven_day', wait_s: 360000, held: 2 })
  assert.deepEqual(toTelemetry(ev('limit', 'overloaded wait_s=300 held=0'))?.attrs, { kind: 'overloaded', window: 'other', wait_s: 300, held: 0 })
  assert.deepEqual(toTelemetry(ev('plan', 'type=team five_hour=60 seven_day=9 seven_day_opus=3 extra=off'))?.attrs, { type: 'team', five_hour: 60, seven_day: 9, seven_day_opus: 3, extra: 'off' })
  assert.deepEqual(toTelemetry(ev('tripwire', 'tick job=93af72f6 outcome=changed ms=812 kb=3'))?.attrs, { action: 'tick', outcome: 'changed', ms: 812 })
  assert.deepEqual(toTelemetry(ev('tool', 'browser_tabs new refused: the owner said no'))?.attrs, { outcome: 'refused' })
  assert.deepEqual(toTelemetry(ev('report', 'needs approval'))?.attrs, { outcome: 'needs' })
  assert.deepEqual(toTelemetry(ev('crash', 'a1b2c3d4e5f6'))?.attrs, { fp: 'a1b2c3d4e5f6' })
  assert.deepEqual(toTelemetry(ev('crash', 'not a fingerprint'))?.attrs, {})
  assert.deepEqual(toTelemetry(ev('grant', 'mcp__slack__x: yes'))?.attrs, {})
  assert.equal(toTelemetry(ev('grant', 'x'))?.name, 'kage.grant')
  assert.equal(toTelemetry(ev('grant', 'x'))?.at, '2026-11-16T10:00:00.000Z')
})

test("a plan row is the seat's plan and how full each window is, and nothing for an API key", () => {
  const rl = { five_hour: { utilization: 60, resets_at: '2026-11-16T17:00:00Z' }, seven_day: { utilization: 9.4, resets_at: null }, seven_day_opus: null, extra_usage: { is_enabled: true, monthly_limit: null, used_credits: null, utilization: null } }
  assert.equal(planDetail({ subscription_type: 'team', rate_limits: rl }), 'type=team five_hour=60 seven_day=9.4 extra=on')
  assert.deepEqual(toTelemetry(ev('plan', planDetail({ subscription_type: 'team', rate_limits: rl })!))?.attrs, { type: 'team', five_hour: 60, seven_day: 9.4, extra: 'on' })
  assert.equal(planDetail({ subscription_type: null, rate_limits: null }), undefined)
})

test('a boot says how the run before it ended, from the last lines that run wrote', () => {
  const at = (s: string) => `2026-11-16T14:22:29.873Z [kage] ${s}`
  assert.equal(bootWhy(at('newer code is in place and every session is quiet: restarting into it')), 'update')
  assert.equal(bootWhy(at('settings changed and every session is quiet: restarting to apply them')), 'settings')
  assert.equal(bootWhy([at('posted in C1 for C1:5.5 (owner)'), at('stopped by SIGTERM')].join('\n')), 'stop')
  assert.equal(bootWhy(at('crashed TypeError: x')), 'crash')
  assert.equal(bootWhy(at('another hub holds the hub lock, so this one exits')), 'duplicate')
  assert.equal(bootWhy(at('posted in C1 for C1:5.5 (owner)')), 'killed')
  assert.equal(bootWhy(''), 'first')
  const start = '2026-11-16T15:50:00.666Z hub.ts: hub start 1 in the last 10 minutes'
  assert.equal(bootWhy([at('newer code is in place and every session is quiet: restarting into it'), start, at('listening as kage'), start].join('\n')), 'killed')
  assert.equal(bootWhy([at('stopped by SIGTERM'), start, at('newer code is in place and every session is quiet: restarting into it'), start, at('jev checks every listed agent')].join('\n')), 'update')
  assert.equal(bootWhy([at('crashed TypeError: x'), ...Array(8).fill('  code: 42,'), '}', start].join('\n')), 'crash')
})

test('an error code comes only from a fixed list of our own log lines', () => {
  assert.equal(errorCode('could not post the pause notice'), 'post_failed')
  assert.equal(errorCode('whatsapp send failed in'), 'post_failed')
  assert.equal(errorCode('replay failed'), 'replay_failed')
  assert.equal(errorCode('could not deliver to a session:'), 'deliver_failed')
  assert.equal(errorCode('session ended'), 'session_ended')
  assert.equal(errorCode('slack socket restart failed'), 'slack_socket')
  assert.equal(errorCode('Priya failed'), undefined)
  assert.equal(errorCode(42), undefined)
})

test('a crash fingerprint names the error class and the first frame inside the repo, not the message or the home path', () => {
  const e = new TypeError('Cannot read properties of undefined (reading Priya)')
  e.stack = `TypeError: Cannot read properties of undefined (reading Priya)\n    at node:internal/x (node:internal/x:1:1)\n    at route (/Users/priya/kage/hub/router.ts:120:9)\n    at main (/Users/priya/kage/hub.ts:5:1)`
  const same = new TypeError('another message for Raj')
  same.stack = `TypeError: another message for Raj\n    at route (/home/raj/.local/share/kage/hub/router.ts:131:2)`
  const other = new RangeError('x')
  other.stack = `RangeError: x\n    at route (/Users/priya/kage/hub/router.ts:120:9)`
  assert.match(crashFingerprint(e, '/Users/priya/kage'), /^[0-9a-f]{12}$/)
  assert.equal(crashFingerprint(e, '/Users/priya/kage'), crashFingerprint(same, '/home/raj/.local/share/kage'))
  assert.notEqual(crashFingerprint(e, '/Users/priya/kage'), crashFingerprint(other, '/Users/priya/kage'))
  assert.match(crashFingerprint('a thrown string', '/x'), /^[0-9a-f]{12}$/)
})

test('telemetry is on by default to the Kage receiver, and on:false, KAGE_TELEMETRY=off or DO_NOT_TRACK turn it off', () => {
  assert.equal(telemetryEndpoint(undefined, {}), TELEMETRY_URL)
  assert.equal(telemetryEndpoint({ endpoint: '' }, {}), TELEMETRY_URL)
  assert.equal(telemetryEndpoint({ endpoint: 'http://127.0.0.1:4318/otlp/' }, {}), 'http://127.0.0.1:4318/otlp')
  assert.equal(telemetryEndpoint({ on: false }, {}), undefined)
  assert.equal(telemetryEndpoint({ endpoint: 'http://x/otlp', on: false }, {}), undefined)
  assert.equal(telemetryEndpoint(undefined, { DO_NOT_TRACK: '1' }), undefined)
  assert.equal(telemetryEndpoint(undefined, { DO_NOT_TRACK: '0' }), TELEMETRY_URL)
  assert.equal(telemetryEndpoint(undefined, { KAGE_TELEMETRY: 'off' }), undefined)
})

test('sessions export Claude Code telemetry as logs only, and turn every flag that sends prompts, replies or tool input to 0', () => {
  const env = sessionTelemetryEnv('http://x/otlp', { 'service.name': 'kage', 'kage.install': 'a b,c' })
  assert.equal(env.CLAUDE_CODE_ENABLE_TELEMETRY, '1')
  assert.equal(env.OTEL_LOGS_EXPORTER, 'otlp')
  assert.equal(env.OTEL_METRICS_EXPORTER, 'none')
  assert.equal(env.OTEL_EXPORTER_OTLP_ENDPOINT, 'http://x/otlp')
  assert.equal(env.OTEL_EXPORTER_OTLP_PROTOCOL, 'http/json')
  assert.equal(env.OTEL_RESOURCE_ATTRIBUTES, 'kage.install=a%20b%2Cc')
  for (const [k, v] of Object.entries(env)) if (/^OTEL_LOG_/.test(k)) assert.equal(v, '0', k)
  for (const k of ['OTEL_LOG_USER_PROMPTS', 'OTEL_LOG_ASSISTANT_RESPONSES', 'OTEL_LOG_TOOL_DETAILS', 'OTEL_LOG_TOOL_CONTENT', 'OTEL_LOG_RAW_API_BODIES']) assert.equal(env[k], '0', k)
})
