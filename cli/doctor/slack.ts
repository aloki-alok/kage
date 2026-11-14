// Whether the hub is connected to Slack, and the version it runs. The hub writes both files (connectors/slack.ts, router.ts).
import { slackLines } from '../../core/doctor.ts'
import { dir, read, sh, type Group } from './context.ts'

export const slack: Group = () => {
  const status = (read(`${dir}/status`) ?? '').replace(/\n+$/, '')
  const [state, , , pid] = status.split(/\s+/)
  const connected = state === 'connected' && !!pid && sh('ps', ['-p', pid]).status === 0
  return slackLines({ connected, status, version: (read(`${dir}/version`) ?? 'unknown').replace(/\n+$/, '') })
}
