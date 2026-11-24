import { createHmac, timingSafeEqual } from 'node:crypto'

export function signedSha256(secret: string, body: string | Buffer, header: string | undefined): boolean {
  if (!secret || !header) return false
  const want = Buffer.from(`sha256=${createHmac('sha256', secret).update(body).digest('hex')}`)
  const got = Buffer.from(header)
  return got.length === want.length && timingSafeEqual(got, want)
}

const SLACK_WINDOW_SECONDS = 300

export const slackStampFresh = (stamp: string | undefined, now: number) =>
  !!stamp && /^\d+$/.test(stamp) && Math.abs(now / 1000 - Number(stamp)) <= SLACK_WINDOW_SECONDS

export function slackSigned(secret: string, stamp: string | undefined, body: string | Buffer, header: string | undefined, now: number): boolean {
  if (!secret || !header || !slackStampFresh(stamp, now)) return false
  const want = Buffer.from(`v0=${createHmac('sha256', secret).update(`v0:${stamp}:`).update(body).digest('hex')}`)
  const got = Buffer.from(header)
  return got.length === want.length && timingSafeEqual(got, want)
}
