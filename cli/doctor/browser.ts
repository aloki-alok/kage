// Kage in Chrome (#114): the hub notes each poll of the extension in browser-seen (router.ts). Checked only when a token is set and the hub runs.
import { chromeLine } from '../../core/doctor.ts'
import { settings } from '../home.ts'
import { dir, hubRunning, nowSec, read, type Group } from './context.ts'

export const browser: Group = () =>
  settings().secrets.browserToken && hubRunning() ? [chromeLine(Number(read(`${dir}/browser-seen`) ?? 0) || 0, nowSec())] : []
