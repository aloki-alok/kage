// Whether the OS keeps the hub running, and the notes about restarts and sleep.
import { userInfo } from 'node:os'
import { bootNotes, lingerLine, serviceLines } from '../../core/doctor.ts'
import { dir, name, nowSec, oldTmux, read, service as svc, sh, type Group } from './context.ts'

export const service: Group = () => {
  const installed = svc('installed').status === 0
  const lines = serviceLines({ name, installed, running: installed && svc('running').status === 0, stale: installed && svc('stale').status === 0, oldTmux: !installed && oldTmux() })
  const kind = svc('kind').stdout.trim()
  const user = userInfo().username
  const linger = kind === 'systemd' ? sh('loginctl', ['show-user', user, '-p', 'Linger', '--value']).stdout.trim() : ''
  const l = lingerLine({ kind, linger, user })
  return [...lines, ...(l ? [l] : []), ...bootNotes({ boots: read(`${dir}/boots`), now: nowSec(), darwin: process.platform === 'darwin' })]
}
