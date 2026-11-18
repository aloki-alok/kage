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

export function emptyRoom(configDir: string): string {
  const room = `${configDir}/standin`
  mkdirSync(room, { recursive: true, mode: 0o700 })
  return room
}
