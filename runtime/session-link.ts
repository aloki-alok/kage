// The local socket the thread sessions connect to. Newline-delimited JSON; the socket file is
// private to this user.
import { chmodSync, unlinkSync } from 'node:fs'
import { createServer } from 'node:net'
import type { Dispatcher } from '../core/sessions.ts'
import type { FromSession, ToSession } from './protocol.ts'

export function listenForSessions(path: string, d: Dispatcher<ToSession>, o: { mail: (key: string, text: string) => void }) {
  try { unlinkSync(path) } catch {}
  createServer(sock => {
    let key = ''
    let buf = ''
    const send = (m: ToSession) => sock.write(JSON.stringify(m) + '\n')
    sock.on('data', chunk => {
      buf += chunk
      for (let i; (i = buf.indexOf('\n')) >= 0;) {
        const line = buf.slice(0, i)
        buf = buf.slice(i + 1)
        let m: Partial<FromSession> & { key?: unknown; id?: unknown; text?: unknown }
        try { m = JSON.parse(line) } catch { continue }
        if (m.type === 'hello' && !key && typeof m.key === 'string') {
          if (d.connect(m.key, send)) key = m.key
          else sock.destroy()
        } else if (m.type === 'permission' && key && typeof m.id === 'string') {
          d.permission(key, m.id)
        } else if (m.type === 'mail' && key.startsWith('mail:') && typeof m.text === 'string') {
          o.mail(key, m.text)   // a session can mail only its own thread
        }
      }
    })
    sock.on('close', () => { if (key) d.disconnect(key, send) })
    sock.on('error', () => {})
  }).listen(path, () => chmodSync(path, 0o600))
}
