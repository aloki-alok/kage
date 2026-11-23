import type { Secrets, SecretsFile } from './config.ts'

export type SecretCommand = { path: string; command: string }
type Run = (command: string) => string | undefined

const isCommand = (v: unknown): v is { command: string } => typeof v === 'object' && v !== null && typeof (v as { command?: unknown }).command === 'string'
const isGroup = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !isCommand(v)

const leaves = (file: SecretsFile): [string, unknown][] =>
  Object.entries(file).flatMap(([k, v]): [string, unknown][] => (isGroup(v) ? Object.entries(v).map(([n, x]) => [`${k}.${n}`, x]) : [[k, v]]))

export const secretCommands = (file: SecretsFile): SecretCommand[] =>
  leaves(file).flatMap(([path, v]) => (isCommand(v) ? [{ path, command: v.command }] : []))

export function lazySecrets(file: SecretsFile, run: Run): Secrets {
  const copy = (from: Record<string, unknown>) => {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(from)) {
      if (isCommand(v)) Object.defineProperty(out, k, { enumerable: true, get: () => run(v.command) })
      else out[k] = isGroup(v) ? copy(v) : v
    }
    return out
  }
  return copy(file) as Secrets
}

export const failedSecrets = (file: SecretsFile, run: Run): SecretCommand[] => secretCommands(file).filter(c => run(c.command) === undefined)
