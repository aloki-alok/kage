import { spawn } from 'node:child_process'

export function callOwner(command: string | null | undefined, voice: { issueCode: () => string } | undefined, reason: string): Promise<string> {
  if (!command) return Promise.resolve('no connectors.call.command')
  if (!voice) return Promise.resolve('voice is off (voiceToken)')
  const p = spawn(command, { shell: true, stdio: 'ignore', env: { ...process.env, KAGE_CALL_CODE: voice.issueCode(), KAGE_CALL_REASON: reason.slice(0, 300) } })
  const timer = setTimeout(() => p.kill(), 60_000)
  return new Promise(res => { p.on('error', e => res(String(e))); p.on('close', code => { clearTimeout(timer); res(code === 0 ? '' : `dialer exited ${code ?? 'on timeout'}`) }) })
}
