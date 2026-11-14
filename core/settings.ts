// The old env file, read once to import it (runtime/config-files.ts importLegacy), and the answer kage reload gives.
import type { Env } from './config.ts'
// Who may reach Kage. These two lists are the settings a running hub takes without a restart.
export type AllowLists = { teammates: string[]; apps: string[] }

// One NAME=value per line; the last line of a name wins. Indent, spaces around "=" and quotes are dropped.
export function parseEnv(text: string): Env {
  const env: Env = {}
  for (const line of text.split('\n')) {
    const m = /^\s*([A-Z_]+)\s*=\s*["']?(.*?)["']?\s*$/.exec(line)
    if (m) env[m[1]!] = m[2]!
  }
  return env
}

// What kage reload answers (runtime/config-watch.ts check).
export type Reloaded = { changed: string[]; restart: string[]; count: number } | { refused: string }
