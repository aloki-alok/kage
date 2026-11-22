import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CLI = new URL('../tunnel.ts', import.meta.url).pathname
const HOST = 'box.tail1.ts.net:8443'
const STAND_IN = [
  '#!/bin/sh',
  'D=$(dirname "$0")/..',
  'if [ "$1" = version ]; then echo 1.0; exit 0; fi',
  'if [ "$1 $2" = "status --json" ]; then echo \'{"BackendState":"Running","Self":{"DNSName":"box.tail1.ts.net.","CapMap":{"funnel":null}}}\'; exit 0; fi',
  'if [ "$1 $2 $3" = "serve status --json" ]; then n=$(($(cat "$D/reads" 2>/dev/null || echo 0)+1)); echo $n > "$D/reads"; [ "$n" -ge "${FAIL_READ:-99}" ] && exit 1; cat "$D/serve"; exit 0; fi',
  'echo "$@" >> "$D/ran"',
  '[ -n "$FAIL_CMD" ] && exit 1',
  '[ -n "$CRASH" ] && kill -9 $PPID',
  'exit 0',
].join('\n')

const serving = (paths: Record<string, string>) => JSON.stringify({
  TCP: { 8443: { HTTPS: true } }, Web: { [HOST]: { Handlers: Object.fromEntries(Object.entries(paths).map(([p, to]) => [p, { Proxy: to }])) } }, AllowFunnel: { [HOST]: true },
})

function world(config: object, serve: string) {
  const dir = mkdtempSync(join(tmpdir(), 'kage-tunnel-'))
  mkdirSync(`${dir}/bin`)
  writeFileSync(`${dir}/bin/tailscale`, STAND_IN)
  chmodSync(`${dir}/bin/tailscale`, 0o755)
  writeFileSync(`${dir}/serve`, serve)
  writeFileSync(`${dir}/config.json`, JSON.stringify({ version: 1, ...config }))
  writeFileSync(`${dir}/secrets.json`, JSON.stringify({ voiceToken: 'v' }), { mode: 0o600 })
  const run = (to: 'on' | 'off', extra: Record<string, string> = {}) => {
    const { KAGE_THREAD: _, KAGE_SESSION: __, ...base } = process.env
    const r = spawnSync(process.execPath, [CLI, to], { encoding: 'utf8', env: { ...base, PATH: `${dir}/bin:${base.PATH}`, KAGE_ENV: `${dir}/env`, ...extra } })
    return { out: r.stdout + r.stderr, code: r.status, signal: r.signal }
  }
  const ran = () => existsSync(`${dir}/ran`) ? readFileSync(`${dir}/ran`, 'utf8').trim().split('\n') : []
  const tunnel = () => JSON.parse(readFileSync(`${dir}/config.json`, 'utf8')).tunnel
  return { run, ran, tunnel }
}

const OLD = { '/mcp': 'http://127.0.0.1:8787/mcp', '/voice': 'http://127.0.0.1:8787/voice' }
const NEW = ['http://127.0.0.1:9200/mcp', 'http://127.0.0.1:9200/voice']

test('when Tailscale\'s serve state cannot be read, kage tunnel runs nothing and saves nothing', () => {
  const w = world({ connectors: { voice: {} } }, '{}')
  const r = w.run('on', { FAIL_READ: '1' })
  assert.equal(r.code, 1)
  assert.match(r.out, /could not read what Tailscale serves/)
  assert.deepEqual([w.ran(), w.tunnel()], [[], undefined])
})

test('Kage killed inside its first command still has every target it set out to open, and the old ones of a moved port', () => {
  const w = world({ tunnel: { provider: 'tailscale', targets: Object.values(OLD) }, connectors: { voice: { port: 9200 } } }, serving(OLD))
  const r = w.run('on', { CRASH: '1' })
  assert.equal(r.signal, 'SIGKILL')
  assert.equal(w.ran().length, 1)
  assert.deepEqual(w.tunnel().targets, [...Object.values(OLD), ...NEW])
})

test('off names each route still served after it ran, the check route too, and never says every route is closed', () => {
  const w = world({ tunnel: { provider: 'tailscale', targets: Object.values(OLD) } }, serving({ ...OLD, '/kage-funnel-check': 'http://127.0.0.1:9' }))
  const r = w.run('off', { FAIL_CMD: '1' })
  assert.equal(r.code, 1)
  for (const p of ['/kage-funnel-check', '/mcp', '/voice']) assert.match(r.out, new RegExp(`Kage could not close a route\\. Run tailscale serve --https=8443 --set-path=${p} off\\.`))
  assert.doesNotMatch(r.out, /Every Kage route is closed/)
})

test('off with nothing of Kage\'s left served says every route is closed', () => {
  const w = world({ tunnel: { provider: 'tailscale' } }, '{}')
  const r = w.run('off')
  assert.deepEqual([r.code, /Every Kage route is closed\./.test(r.out)], [0, true])
})
