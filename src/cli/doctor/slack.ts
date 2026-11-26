import { slackLines } from '../../core/doctor.ts'
import { SLACK_PATH, slackTransport } from '../../core/slack-transport.ts'
import { settings } from '../home.ts'
import { tunnelUrl } from '../tailscale.ts'
import { dir, read, sh, type Group } from './context.ts'

const answerOf = (url: string) => fetch(url, { method: 'POST', signal: AbortSignal.timeout(10_000) }).then(r => r.status, (e: Error) => e.cause instanceof Error ? e.cause.message : e.message)

export const slack: Group = async () => {
  const status = (read(`${dir}/status`) ?? '').replace(/\n+$/, '')
  const [state, , , pid] = status.split(/\s+/)
  const connected = state === 'connected' && !!pid && sh('ps', ['-p', pid]).status === 0
  const base = { connected, status, version: (read(`${dir}/version`) ?? 'unknown').replace(/\n+$/, '') }
  const s = settings()
  if (slackTransport(s) === 'socket') return slackLines({ ...base, transport: 'socket' })
  const url = s.config.slack?.publicUrl ?? tunnelUrl(s.config, SLACK_PATH)
  return slackLines({ ...base, transport: 'http', signing: !!s.secrets.slack?.signing, route: url ? { url, answer: await answerOf(url) } : undefined })
}
