import { readdirSync, statSync } from 'node:fs'
import type { MemoryFile } from '../core/dream.ts'

const KEEP_DOT = new Set(['.dream-ledger.tsv'])

function files(dir: string, prefix: string, keepDot: boolean): MemoryFile[] {
  let names: string[] = []
  try { names = readdirSync(dir) } catch { return [] }
  return names.flatMap(n => {
    if (n.startsWith('.') && !(keepDot && KEEP_DOT.has(n))) return []
    try {
      const s = statSync(`${dir}/${n}`)
      return s.isFile() ? [{ name: `${prefix}${n}`, kb: Math.ceil(s.size / 1024), date: new Date(s.mtimeMs).toISOString().slice(0, 10) }] : []
    } catch { return [] }
  })
}

export function listMemory(dir: string, withArchive: boolean): MemoryFile[] {
  return [...withArchive ? files(`${dir}/.archive`, '.archive/', false) : [], ...files(dir, '', true)]
    .sort((a, b) => a.name < b.name ? -1 : 1)
}
