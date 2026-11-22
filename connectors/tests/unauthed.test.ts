import { test } from 'node:test'
import assert from 'node:assert/strict'
import { connectGithub } from '../github.ts'
import { connectMeeting } from '../meeting.ts'
import { connectVoice } from '../voice.ts'
import { connectBrowser } from '../browser.ts'
import { jobHooks } from '../job-hooks.ts'
import { wahaHandler } from '../whatsapp.ts'
import { listen } from '../webhook.ts'
import { hookTokenHash } from '../../core/tripwire.ts'
import { openStore } from '../../runtime/store.ts'

const inbox = { take: () => true, handled: () => {}, has: () => false }
const deliver = () => 'sent' as const
type Server = { listening?: Promise<number>; close?: () => unknown }

const cases: { name: string; start: () => Server; routes: [method: string, path: string, headers?: Record<string, string>][] }[] = [
  { name: 'github', start: () => connectGithub({ saved: openStore(':memory:'), owner: 'me', accounts: ['me'], app: { id: 1, slug: 'kage-me', key: 'k' }, installations: async () => [], secret: 's', port: 0, botDm: 'DB', perHour: 5, notify: () => {}, inbox, post: async () => '1', deliver }),
    routes: [['POST', '/github', { 'x-hub-signature-256': 'sha256=00' }], ['POST', '/github']] },
  { name: 'meeting', start: () => connectMeeting({ token: 't', port: 0, botDm: 'DB', perHour: 5, pollMs: 50, name: 'kage', askWaitMs: 50, end: () => {}, notify: () => {}, now: () => 0, untake: () => {}, inbox, post: async () => '1', deliver }),
    routes: [['POST', '/meeting'], ['GET', '/meetbot/next'], ['POST', '/meetbot/segments'], ['POST', '/meetbot/ended'], ['POST', '/meeting', { authorization: 'Bearer wrong' }]] },
  { name: 'voice', start: () => connectVoice({ voice: { token: 't', port: 0 }, name: 'kage', waitMs: 50, now: () => 0, slot: () => true, end: () => {}, deliver, failed: () => {} })!,
    routes: [['POST', '/mcp'], ['POST', '/voice/ended'], ['GET', '/mcp', { authorization: 'Bearer wrong' }]] },
  { name: 'browser', start: () => connectBrowser({ token: 't', port: 0 }), routes: [['GET', '/browser/next'], ['POST', '/browser/result'], ['GET', '/browser/next', { authorization: 'Bearer wrong' }]] },
  { name: 'job hooks', start: () => jobHooks({ host: '127.0.0.1', port: 0, inbox, maxKb: () => 1, perHour: () => 5, hookOf: () => ({ key: 'CTEST1:1.1', tokenHash: hookTokenHash('t') }), deliver: () => {}, track: () => {} }),
    routes: [['POST', '/hook/j1'], ['POST', '/hook/j1', { authorization: 'Bearer wrong' }]] },
  { name: 'whatsapp', start: () => listen(wahaHandler('k', inbox, () => {}), 0), routes: [['POST', '/waha'], ['POST', '/waha', { 'x-webhook-hmac': 'wrong' }]] },
]

for (const c of cases) {
  test(`${c.name}: every route answers 401 without its credential`, { timeout: 10_000 }, async () => {
    const s = c.start()
    try {
      const port = await s.listening!
      for (const [method, path, headers] of c.routes) {
        const r = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers, ...(method === 'POST' && { body: '{}' }) })
        assert.equal(r.status, 401, `${method} ${path} ${JSON.stringify(headers ?? {})}`)
      }
    } finally { await s.close?.() }
  })
}
