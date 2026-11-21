import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import type { Lean } from './sdk-sessions.ts'

const json = (file: string): Record<string, unknown> => { try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return {} } }
const text = (v: unknown) => typeof v === 'string' && v ? v : undefined

export function ownerClaude(env: { HOME?: string; CLAUDE_CONFIG_DIR?: string } = process.env): Lean {
  const dir = env.CLAUDE_CONFIG_DIR || `${env.HOME || homedir()}/.claude`
  const settings = json(`${dir}/settings.json`)
  const state = json(env.CLAUDE_CONFIG_DIR ? `${dir}/.claude.json` : `${env.HOME || homedir()}/.claude.json`)
  const mcp = state.mcpServers && typeof state.mcpServers === 'object' ? state.mcpServers as Record<string, unknown> : {}
  return { model: text(settings.model), effort: text(settings.effortLevel), mcp }
}
