import { appendFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type RequestListener } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { signedSha256 } from '../core/signature.ts'
import { loadConfig, loadSecrets, readJobAndPack } from './config.ts'
import { threadKey } from './decide.ts'
import { graphPost } from './graph.ts'
import { metaEvents, type MetaEvent } from './meta.ts'
import { chat } from './model.ts'
import { handle } from './reply.ts'
import { openStore } from './store.ts'

const MAX_BODY = 1_000_000

function readBody(req: IncomingMessage): Promise<Buffer | undefined> {
  return new Promise(done => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => { size += c.length; if (size <= MAX_BODY) chunks.push(c) })
    req.on('end', () => done(size <= MAX_BODY ? Buffer.concat(chunks) : undefined))
    req.on('error', () => done(undefined))
  })
}

export function webhook(o: { verifyToken: string; appSecret: string; onEvents: (evs: MetaEvent[]) => void }): RequestListener {
  return async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    if (url.pathname === '/health') { res.writeHead(200).end('ok'); return }
    if (url.pathname !== '/webhook') { res.writeHead(404).end(); return }
    if (req.method === 'GET') {
      const ok = o.verifyToken && url.searchParams.get('hub.mode') === 'subscribe' && url.searchParams.get('hub.verify_token') === o.verifyToken
      res.writeHead(ok ? 200 : 403).end(ok ? url.searchParams.get('hub.challenge') ?? '' : '')
      return
    }
    if (req.method !== 'POST') { res.writeHead(405).end(); return }
    const body = await readBody(req)
    if (!body) { res.writeHead(413).end(); req.destroy(); return }
    if (!signedSha256(o.appSecret, body, req.headers['x-hub-signature-256'] as string | undefined)) { res.writeHead(401).end(); return }
    res.writeHead(200).end('ok')
    let parsed: unknown
    try { parsed = JSON.parse(body.toString('utf8')) } catch { return }
    o.onEvents(metaEvents(parsed))
  }
}

export function serve(dir = process.env.METABOT_DIR || join(homedir(), '.config', 'kage', 'metabot')) {
  const cfg = loadConfig(dir), sec = loadSecrets(dir)
  const store = openStore(join(dir, 'metabot.db'))
  const log = (line: string) => process.stderr.write(`${new Date().toISOString()} [metabot] ${line}\n`)
  const deps = {
    store, now: Date.now, settings: cfg.settings,
    read: () => readJobAndPack(dir, cfg.packDir),
    model: (m: Parameters<typeof chat>[2], json: boolean) => chat(cfg.model, sec.modelKey, m, json),
    send: (r: Parameters<typeof graphPost>[1]) => graphPost(sec.pageToken, r),
    ...(cfg.sinkUrl ? { sink: async (l: unknown) => {
      const r = await fetch(cfg.sinkUrl, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${sec.sinkToken}` }, body: JSON.stringify(l), signal: AbortSignal.timeout(15_000) })
      if (!r.ok) throw new Error(`sink answered ${r.status}`)
    } } : {}),
    missed: (q: string) => appendFileSync(join(dir, 'missed.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), question: q })}\n`, { mode: 0o600 }),
  }
  const chains = new Map<string, Promise<unknown>>()
  const onEvents = (evs: MetaEvent[]) => {
    for (const ev of evs) {
      const key = threadKey(ev)
      const next = (chains.get(key) ?? Promise.resolve()).then(() => handle(ev, deps))
        .then(outcome => log(`${ev.channel} ${ev.kind} ${outcome}`), e => log(`${ev.channel} ${ev.kind} error ${e instanceof Error ? e.message : e}`))
        .finally(() => { if (chains.get(key) === next) chains.delete(key) })
      chains.set(key, next)
    }
  }
  setInterval(() => store.prune(Date.now() - cfg.linesKeptDays * 86_400_000), 6 * 3_600_000).unref()
  const server = createServer(webhook({ verifyToken: sec.verifyToken, appSecret: sec.appSecret, onEvents }))
  server.listen(cfg.port, '127.0.0.1', () => log(`listening on 127.0.0.1:${cfg.port}, mode ${cfg.settings.mode}`))
  return server
}

if (process.argv[1] === fileURLToPath(import.meta.url)) serve()
