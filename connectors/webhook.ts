// What the connectors that listen on a local port share: the body reader, the bearer check and the hourly cap.
// Each connector keeps its own status codes and its own order of checks.
import { createHash, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type RequestListener } from 'node:http'
import type { AddressInfo } from 'node:net'

export function listen(handler: RequestListener, port: number, host = '127.0.0.1') {
  const server = createServer({ requestTimeout: 10_000, connectionsCheckingInterval: 1_000 }, handler)
  const listening = new Promise<number>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => resolve((server.address() as AddressInfo).port))
  })
  return { server, listening, close: () => { server.closeAllConnections(); server.close() } }
}

// The whole body as bytes (decode once, so a character split across chunks cannot break a signature).
// Nothing above max: the caller answers 413 and destroys the request.
export function readBody(req: IncomingMessage, max: number): Promise<Buffer | undefined> {
  return new Promise(done => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size <= max) chunks.push(c)
      else done(undefined)
    })
    req.on('end', () => done(size <= max ? Buffer.concat(chunks) : undefined))
    req.on('error', () => done(undefined))
  })
}

const digest = (s: string) => createHash('sha256').update(s).digest()
export const bearerOk = (header: string | undefined, token: string) => timingSafeEqual(digest(header ?? ''), digest(`Bearer ${token}`))

// When each of the last hour's starts happened. tell() is true once per full spell, so the owner hears it once.
export function hourCap(perHour: number) {
  const started: number[] = []
  let told = false
  return {
    full(now: number) {
      while (started.length && now - started[0]! > 3_600_000) started.shift()
      return started.length >= perHour
    },
    tell() { const first = !told; told = true; return first },
    add(now: number) { started.push(now); told = false },
  }
}
