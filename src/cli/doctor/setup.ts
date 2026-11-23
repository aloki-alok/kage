import { statSync } from 'node:fs'
import { jevLine, tokenLines, toolsLine } from '../../core/doctor.ts'
import { settingsExist } from '../home.ts'
import { dir, onPath, read, runtime, sh, type Group } from './context.ts'

const mode = (f: string) => { try { return (statSync(f).mode & 0o777).toString(8) } catch { return undefined } }

export const setup: Group = () => {
  const tools = toolsLine({ nodeVersion: process.versions.node, claude: onPath('claude'), tmuxNeeded: runtime === 'tmux', tmux: onPath('tmux') })
  if (!settingsExist()) return [tools, ...tokenLines({ hasSettings: false, dir, slack: {} })]
  const file = read(`${dir}/secrets.json`) !== undefined ? `${dir}/secrets.json` : `${dir}/env`
  const slack = Object.fromEntries((['app', 'user', 'bot'] as const).map(k => [k, sh('node', ['src/cli/config.ts', 'check-slack', k]).status === 0]))
  const j = sh('node', ['src/cli/jev-doctor.ts'])
  const jev = jevLine({ status: j.status ?? 1, out: j.stdout.trim() })
  return [tools, ...tokenLines({ hasSettings: true, dir, file, mode: mode(file), slack }), ...(jev ? [jev] : [])]
}
