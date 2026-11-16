import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { EventKind, KageEvent } from '../events.ts'
import { crashFingerprint, sessionTelemetryEnv, telemetryEndpoint, toTelemetry } from '../telemetry.ts'

const KINDS: EventKind[] = ['run.start', 'run.end', 'tool', 'handoff', 'grant', 'refusal', 'revoke', 'owner-note', 'report', 'cap-pause', 'cost-flag', 'config.live', 'config.restart', 'config.refused', 'memory-proposal', 'memory-decision', 'day-summary', 'triage', 'tripwire', 'crash']
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
  for (const kind of KINDS) for (const d of ['$0.12, no report', 'tick job=a1 outcome=changed ms=40', 'task from x', 'browser_act open refused: no', 'needs approval', 'deadbeefcafe']) {
    const r = toTelemetry(ev(kind, d))
    if (!r) continue
    for (const [k, v] of Object.entries(r.attrs)) {
      if (typeof v === 'number') assert.ok(Number.isFinite(v), `${kind}.${k}`)
      else assert.match(v, /^[a-z0-9.]{1,16}$/, `${kind}.${k}=${v}`)
    }
  }
})

test('the known shapes give their counts and codes', () => {
  assert.deepEqual(toTelemetry(ev('run.end', '$0.19, no report'))?.attrs, { cost_usd: 0.19, report: 'no' })
  assert.deepEqual(toTelemetry(ev('run.end', '$1.05, reported'))?.attrs, { cost_usd: 1.05, report: 'yes' })
  assert.deepEqual(toTelemetry(ev('run.start', 'scheduled 93af72f6'))?.attrs, { trigger: 'scheduled' })
  assert.deepEqual(toTelemetry(ev('run.start', 'Priya asked for x'))?.attrs, { trigger: 'other' })
  assert.deepEqual(toTelemetry(ev('tripwire', 'tick job=93af72f6 outcome=changed ms=812 kb=3'))?.attrs, { action: 'tick', outcome: 'changed', ms: 812 })
  assert.deepEqual(toTelemetry(ev('tool', 'browser_act open refused: the owner said no'))?.attrs, { outcome: 'refused' })
  assert.deepEqual(toTelemetry(ev('report', 'needs approval'))?.attrs, { outcome: 'needs' })
  assert.deepEqual(toTelemetry(ev('crash', 'a1b2c3d4e5f6'))?.attrs, { fp: 'a1b2c3d4e5f6' })
  assert.deepEqual(toTelemetry(ev('crash', 'not a fingerprint'))?.attrs, {})
  assert.deepEqual(toTelemetry(ev('grant', 'mcp__slack__x: yes'))?.attrs, {})
  assert.equal(toTelemetry(ev('grant', 'x'))?.name, 'kage.grant')
  assert.equal(toTelemetry(ev('grant', 'x'))?.at, '2026-11-16T10:00:00.000Z')
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

test('telemetry sends only with an endpoint, and DO_NOT_TRACK, KAGE_TELEMETRY=off or on:false turn it off', () => {
  assert.equal(telemetryEndpoint(undefined, {}), undefined)
  assert.equal(telemetryEndpoint({ endpoint: '' }, {}), undefined)
  assert.equal(telemetryEndpoint({ endpoint: 'http://127.0.0.1:4318/otlp/' }, {}), 'http://127.0.0.1:4318/otlp')
  assert.equal(telemetryEndpoint({ endpoint: 'http://x/otlp', on: false }, {}), undefined)
  assert.equal(telemetryEndpoint({ endpoint: 'http://x/otlp' }, { DO_NOT_TRACK: '1' }), undefined)
  assert.equal(telemetryEndpoint({ endpoint: 'http://x/otlp' }, { DO_NOT_TRACK: '0' }), 'http://x/otlp')
  assert.equal(telemetryEndpoint({ endpoint: 'http://x/otlp' }, { KAGE_TELEMETRY: 'off' }), undefined)
})

test('sessions export Claude Code telemetry as logs only, and never turn on a flag that sends prompts, replies or tool input', () => {
  const env = sessionTelemetryEnv('http://x/otlp', { 'service.name': 'kage', 'kage.install': 'a b,c' })
  assert.equal(env.CLAUDE_CODE_ENABLE_TELEMETRY, '1')
  assert.equal(env.OTEL_LOGS_EXPORTER, 'otlp')
  assert.equal(env.OTEL_METRICS_EXPORTER, 'none')
  assert.equal(env.OTEL_EXPORTER_OTLP_ENDPOINT, 'http://x/otlp')
  assert.equal(env.OTEL_EXPORTER_OTLP_PROTOCOL, 'http/json')
  assert.equal(env.OTEL_RESOURCE_ATTRIBUTES, 'kage.install=a%20b%2Cc')
  for (const k of Object.keys(env)) assert.ok(!/^OTEL_LOG_|RAW_API|TOOL_CONTENT/.test(k), k)
})
