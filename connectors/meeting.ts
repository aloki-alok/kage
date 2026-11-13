// Meeting connector: a finished meeting's transcript wakes Kage for notes and proposed follow-ups
// (core/meeting.ts). A meeting bot such as Vexa, or any script, posts the transcript to
// 127.0.0.1:<port>/meeting with `Authorization: Bearer <KAGE_MEETING_TOKEN>`. Each meeting gets
// its own thread in the owner's DM with Kage, and the owner answers there in person. The words are
// other people's, so the task runs at teammate trust. Off unless KAGE_MEETING_TOKEN is set.
// This mirrors connectors/github.ts; the bearer token is the voice connector's check.
import { createHash, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { log } from '../config.ts'
import type { Conversation } from '../core/conversations.ts'
import { meetingTask, parseMeeting } from '../core/meeting.ts'
import type { Delivery } from '../core/sessions.ts'
import type { Task } from '../runtime/protocol.ts'
import type { Inbox } from '../runtime/store.ts'

const MAX_BODY = 5_000_000   // a Vexa transcript with word timings for a long call fits well under this

const digest = (s: string) => createHash('sha256').update(s).digest()
const bearerOk = (header: string | undefined, token: string) => timingSafeEqual(digest(header ?? ''), digest(`Bearer ${token}`))

export function connectMeeting(o: {
  token: string; port: number; botDm: string
  post: (text: string) => Promise<string | undefined>   // a new message in the owner's DM with Kage; its ts
  deliver: (c: Conversation, task: Task, place: string) => Delivery
  notify: (text: string) => void
  perHour: number
  inbox: Inbox
}) {
  const started: number[] = []
  let capTold = false

  // false: nothing in it to take notes on (the sender is told 400).
  async function handle(body: string): Promise<boolean> {
    let raw: unknown
    try { raw = JSON.parse(body) } catch { return false }
    const m = parseMeeting(raw)
    if (!m) return false
    const now = Date.now()
    while (started.length && now - started[0]! > 3600_000) started.shift()
    if (started.length >= o.perHour) {
      if (!capTold) o.notify(`More than ${o.perHour} meeting transcripts came in this hour, so I am skipping them until the hour is up. Latest: ${m.title}.`)
      capTold = true
      return true
    }
    started.push(now)
    capTold = false
    const plain = (t: string) => t.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    const thread = await o.post(`*Meeting:* ${plain(m.title)}${m.link ? ` <${m.link}|open>` : ''}`)
    if (!thread) { o.notify(`Notes for the meeting "${m.title}" could not open a thread here.`); return true }
    const place = `Meeting ${m.title}`
    const task: Task = {
      type: 'task', fromOwner: false, content: meetingTask(m),
      meta: { channel: o.botDm, thread_ts: thread, place, permalink: m.link },
      origin: { channel: o.botDm, ts: thread },
    }
    if (o.deliver({ connector: 'slack', chat: o.botDm, thread, kind: 'dm' }, task, place) === 'failed') o.notify(`Could not start a session for ${place}.`)
    return true
  }

  const run = async (body: string, source: string) => {
    try { return await handle(body) } finally { o.inbox.handled(source) }
  }
  const server = createServer((req, res) => {
    if (!bearerOk(req.headers.authorization, o.token)) { res.writeHead(401).end(); return }
    if (req.method !== 'POST' || req.url !== '/meeting') { res.writeHead(404).end(); return }
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size <= MAX_BODY) chunks.push(c)
      else { res.writeHead(413).end(); req.destroy() }
    })
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      // Into the inbox first, keyed by the body: a sender that retries runs once, and a hub that dies
      // while handling it replays it on the next start (router.ts).
      const source = `meeting:${createHash('sha256').update(body).digest('hex').slice(0, 32)}`
      if (!o.inbox.take(source, 'meeting', body)) { res.writeHead(202).end(); return }
      run(body, source)
        .then(took => res.writeHead(took ? 202 : 400).end())
        .catch(e => {
          log('meeting transcript failed', e)
          o.notify(`A meeting transcript failed here (${String(e).slice(0, 120)}). Send it again.`)
          res.writeHead(500).end()
        })
    })
  })
  const listening = new Promise<number>(ok => server.listen(o.port, '127.0.0.1', () => ok((server.address() as AddressInfo).port)))
  return { listening, replay: (source: string, body: string) => run(body, source), close: () => server.close() }
}
