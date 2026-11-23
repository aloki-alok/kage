import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import type { Lean } from './sdk-sessions.ts'

const record = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}
const json = (file: string) => { try { return record(JSON.parse(readFileSync(file, 'utf8'))) } catch { return {} } }
const text = (v: unknown) => typeof v === 'string' && v ? v : undefined

export function ownerClaude(env: { HOME?: string; CLAUDE_CONFIG_DIR?: string } = process.env): Lean {
  const dir = env.CLAUDE_CONFIG_DIR || `${env.HOME || homedir()}/.claude`
  const settings = json(`${dir}/settings.json`)
  const state = json(env.CLAUDE_CONFIG_DIR ? `${dir}/.claude.json` : `${env.HOME || homedir()}/.claude.json`)
  const mcp = record(state.mcpServers)
  return { model: text(settings.model), effort: text(settings.effortLevel), mcp, permissions: record(settings.permissions) }
}
