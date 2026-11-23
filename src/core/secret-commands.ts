import type { Secrets, SecretsFile } from './config.ts'

export type SecretCommand = { path: string; command: string }

const isCommand = (v: unknown): v is { command: string } => typeof v === 'object' && v !== null && typeof (v as { command?: unknown }).command === 'string'
const isGroup = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !isCommand(v)

const leaves = (file: SecretsFile): [string, unknown][] =>
  Object.entries(file).flatMap(([k, v]): [string, unknown][] => (isGroup(v) ? Object.entries(v).map(([n, x]) => [`${k}.${n}`, x]) : [[k, v]]))

export const secretCommands = (file: SecretsFile): SecretCommand[] =>
  leaves(file).flatMap(([path, v]) => (isCommand(v) ? [{ path, command: v.command }] : []))

export function resolveSecrets(file: SecretsFile, run: (command: string) => string | undefined): { secrets: Secrets; failed: SecretCommand[] } {
  const failed: SecretCommand[] = []
  const value = (path: string, v: unknown) => {
    if (!isCommand(v)) return v
    const out = run(v.command)
    if (out === undefined) failed.push({ path, command: v.command })
    return out
  }
  const kept = (entries: [string, unknown][]) => Object.fromEntries(entries.filter(([, v]) => v !== undefined))
  const secrets = kept(Object.entries(file).map(([k, v]) => [k, isGroup(v) ? kept(Object.entries(v).map(([n, x]) => [n, value(`${k}.${n}`, x)])) : value(k, v)]))
  return { secrets: secrets as Secrets, failed }
}
