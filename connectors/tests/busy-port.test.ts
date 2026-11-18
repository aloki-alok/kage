// A connector whose port is taken must turn itself off, not crash the hub: an unhandled 'error' on the server
// exits the process, the service restarts it, and it crashes again on the same port.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { connectGithub } from '../github.ts'
import { connectMeeting } from '../meeting.ts'
import { connectVoice } from '../voice.ts'
import { connectBrowser } from '../browser.ts'
import { jobHooks } from '../job-hooks.ts'
import { openStore } from '../../runtime/store.ts'

const inbox = { take: () => true, handled: () => {}, has: () => false }
const deliver = () => 'sent' as const

const starts: Record<string, (port: number) => { listening: Promise<number>; close?: () => unknown } | undefined> = {
  github: port => connectGithub({ saved: openStore(':memory:'), secret: 's', login: 'me', port, botDm: 'DB', perHour: 5, notify: () => {}, inbox, post: async () => '1', deliver }),
  meeting: port => connectMeeting({ token: 't', port, botDm: 'DB', perHour: 5, pollMs: 50, name: 'kage', askWaitMs: 50, end: () => {}, notify: () => {}, now: () => 0, untake: () => {}, inbox, post: async () => '1', deliver }),
  voice: port => connectVoice({ voice: { token: 't', port }, name: 'kage', waitMs: 50, now: () => 0, slot: () => true, end: () => {}, deliver, failed: () => {} }),
  browser: port => connectBrowser({ token: 't', port }),
  'job hooks': port => jobHooks({ host: '127.0.0.1', port, inbox, maxKb: () => 1, perHour: () => 5, hookOf: () => undefined, deliver: () => {}, track: () => {} }),
}

for (const [name, start] of Object.entries(starts)) {
  test(`${name}: a taken port rejects listening and leaves the hub running`, { timeout: 5000 }, async () => {
    const busy = createServer().listen(0, '127.0.0.1')
    await new Promise(r => busy.once('listening', r))
    const port = (busy.address() as AddressInfo).port
    const crashed: unknown[] = []
    const onCrash = (e: unknown) => crashed.push(e)
    process.on('uncaughtException', onCrash)
    try {
      const c = start(port)!
      await assert.rejects(c.listening, /EADDRINUSE/)
      await new Promise(r => setTimeout(r, 50))
      assert.deepEqual(crashed, [])
      c.close?.()
    } finally {
      process.off('uncaughtException', onCrash)
      busy.close()
    }
  })
}
