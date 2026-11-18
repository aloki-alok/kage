import { createHmac, timingSafeEqual } from 'node:crypto'

export function signedSha256(secret: string, body: string | Buffer, header: string | undefined): boolean {
  if (!secret || !header) return false
  const want = Buffer.from(`sha256=${createHmac('sha256', secret).update(body).digest('hex')}`)
  const got = Buffer.from(header)
  return got.length === want.length && timingSafeEqual(got, want)
}
