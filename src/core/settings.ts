import type { Env } from './config.ts'
export type AllowLists = { teammates: string[]; trusted: string[]; emails: string[]; apps: string[] }

export function parseEnv(text: string): Env {
  const env: Env = {}
  for (const line of text.split('\n')) {
    const m = /^\s*([A-Z_]+)\s*=\s*["']?(.*?)["']?\s*$/.exec(line)
    if (m) env[m[1]!] = m[2]!
  }
  return env
}

export type Reloaded = { changed: string[]; restart: string[]; count: number } | { refused: string }
