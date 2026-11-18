import { writeFileSync } from 'node:fs'
import type { SocketModeClient } from '@slack/socket-mode'
import { socketWatch } from '../core/socket-watch.ts'
import { log } from '../runtime/log.ts'

export function keepSocketUp(socket: SocketModeClient, o: { dir: string; name: string; gap: () => void; notifyOwner: (text: string) => void }) {
  const watch = socketWatch({ downMs: 3 * 60_000 })
  const status = (state: 'connected' | 'disconnected') => {
    try { writeFileSync(`${o.dir}/status`, `${state} ${new Date().toISOString()} pid ${process.pid} as @${o.name}\n`, { mode: 0o600 }) } catch {}
  }
  socket.on('connected', () => { watch.connected(); status('connected'); log('slack socket connected') })
  socket.on('disconnected', () => { o.gap(); watch.down(Date.now()); status('disconnected'); log('slack socket disconnected') })
  socket.on('reconnecting', () => { o.gap(); watch.down(Date.now()); status('disconnected'); log('slack socket reconnecting') })
  let armed = false, restarting = false
  socket.once('connected', () => { armed = true })
  setInterval(() => {
    if (!armed || restarting) return
    const v = watch.check(Date.now())
    if (v === 'ok' || v === 'wait') return
    log('slack socket down for 3 minutes: restarting it')
    restarting = true
    socket.disconnect().catch(() => {}).then(() => socket.start()).catch(e => log('slack socket restart failed', e)).finally(() => { restarting = false })
    if (v === 'restart and tell') o.notifyOwner('Slack has not reconnected for 6 minutes, so I may miss tags. I keep retrying. If it lasts, run `kage logs` on the Mac.')
  }, 30_000).unref()
}
