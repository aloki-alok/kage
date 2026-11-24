import type { IncomingMessage, ServerResponse } from 'node:http'
import { log } from '../../runtime/log.ts'
import { slackSigned, slackStampFresh } from '../../core/signature.ts'
import { SLACK_PATH, slackRequest } from '../../core/slack-transport.ts'
import { listen, readBody } from '../webhook.ts'

const MAX_BODY = 1_000_000

type Ack = (response?: object) => Promise<void>
type Delivery = { ack: Ack; body: object; event?: object; retry_num?: number }
type Listener = (delivery: Delivery) => unknown
export type SlackIntake = { on(name: string, listener: (delivery: any) => unknown): unknown; start(): Promise<unknown> }

export function slackHttp(o: { secret: string; port: number }) {
  const listeners = new Map<string, Listener[]>()
  const listenersOf = (name: string) => listeners.get(name) ?? []
  let server: ReturnType<typeof listen> | undefined
  return {
    on(name: string, listener: Listener) { listeners.set(name, [...listenersOf(name), listener]) },
    async start() {
      server = listen((req, res) => answer(o.secret, listenersOf, req, res), o.port)
      const port = await server.listening
      log(`slack http on: 127.0.0.1:${port}${SLACK_PATH}`)
      for (const connected of listenersOf('connected')) (connected as () => unknown)()
      return port
    },
    close: () => server?.close(),
  }
}

function answer(secret: string, listenersOf: (name: string) => Listener[], req: IncomingMessage, res: ServerResponse) {
  if (req.method !== 'POST' || req.url !== SLACK_PATH) { res.writeHead(404).end(); return }
  const stamp = req.headers['x-slack-request-timestamp'] as string | undefined, signature = req.headers['x-slack-signature'] as string | undefined
  if (!signature || !slackStampFresh(stamp, Date.now())) { res.writeHead(401).end(); return }
  void (async () => {
    const raw = await readBody(req, MAX_BODY)
    if (!raw) { res.writeHead(413).end(); req.destroy(); return }
    if (!slackSigned(secret, stamp, raw, signature, Date.now())) { res.writeHead(401).end(); return }
    const r = slackRequest(String(req.headers['content-type'] ?? ''), raw.toString('utf8'))
    if (!r) { res.writeHead(400).end(); return }
    if (r.kind === 'challenge') { res.writeHead(200, { 'content-type': 'text/plain' }).end(r.challenge); return }
    const retry = Number(req.headers['x-slack-retry-num']) || undefined
    if (retry) log(`slack http retry ${retry} of ${r.name}`)
    await dispatch(res, listenersOf(r.name), { body: r.body, ...(r.event && { event: r.event }), ...(retry && { retry_num: retry }) })
  })().catch(e => { log('slack http request failed', e); if (!res.headersSent) res.writeHead(500).end() })
}

async function dispatch(res: ServerResponse, listeners: Listener[], delivery: Omit<Delivery, 'ack'>) {
  const ack: Ack = async response => {
    if (res.headersSent) return
    if (response) res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(response))
    else res.writeHead(200).end()
  }
  for (const listener of listeners) await listener({ ...delivery, ack })
  await ack()
}
