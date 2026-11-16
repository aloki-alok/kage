// One isolated `claude -p` answer, for the guards and stand-ins that must not see Kage's setup: no MCP, no
// settings (so no CLAUDE.md, hooks or allow rules), nothing saved. In -p mode a read outside cwd is denied
// (tested 2026-11-03), so read-only tools reach only the folder given. Killed after 2 minutes, or timeoutMs.
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'

export function claudeOnce(o: { model: string; system: string; prompt: string; cwd: string; tools: string; allowed?: string; timeoutMs?: number }): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn('claude', ['-p', '--tools', o.tools, ...(o.allowed ? ['--allowedTools', o.allowed] : []), '--strict-mcp-config', '--setting-sources', '',
      '--no-session-persistence', '--model', o.model, '--system-prompt', o.system], { cwd: o.cwd, stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    p.stdout.on('data', c => { out += c })
    const timer = setTimeout(() => p.kill(), o.timeoutMs ?? 120_000)
    p.on('close', code => { clearTimeout(timer); code === 0 ? resolve(out.trim()) : reject(new Error(`claude exited ${code}`)) })
    p.stdin.end(o.prompt)
  })
}

// An empty folder in Kage's config folder, so a guard's Claude finds no CLAUDE.md or project memory.
export function emptyRoom(configDir: string): string {
  const room = `${configDir}/standin`
  mkdirSync(room, { recursive: true, mode: 0o700 })
  return room
}
