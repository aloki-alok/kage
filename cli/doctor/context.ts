// What every doctor check group shares: where Kage lives, its settings, and how to ask the shell.
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { DIR, ENV_FILE, settings } from '../home.ts'
import type { Line } from '../../core/doctor.ts'

export const ROOT = new URL('../../', import.meta.url).pathname.replace(/\/$/, '')
export const config = settings().config
export const name = config.name || 'kage'
export const dir = DIR
export const runtime = config.harness?.runtime ?? undefined
export const nowSec = () => Math.floor(Date.now() / 1000)
export type Group = () => Line[] | Promise<Line[]>

// git never prompts, and gives up on a dead network after 10 s (the auto-update check).
const env = { ...process.env, KAGE_ENV: ENV_FILE, GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o ConnectTimeout=10' }
export const sh = (cmd: string, args: string[] = [], timeout?: number) => spawnSync(cmd, args, { cwd: ROOT, env, encoding: 'utf8', timeout })
export const onPath = (cmd: string) => sh('sh', ['-c', 'command -v "$1"', '_', cmd]).status === 0
export const service = (cmd: string) => sh('./service.sh', [cmd])
export const read = (file: string) => { try { return readFileSync(file, 'utf8') } catch { return undefined } }

// The hub runs when its service runs, or when an old tmux session from before the service holds it.
export const oldTmux = () => onPath('tmux') && sh('tmux', ['has-session', '-t', `=${name}`]).status === 0
export const hubRunning = () => (service('installed').status === 0 && service('running').status === 0) || oldTmux()
