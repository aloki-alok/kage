// The bot's folder: config.json (settings), secrets.json (tokens, mode 600), job.md (the business's rules) and the
// knowledge pack (every .md file; links.md holds the links the bot may send). Settings fall back to safe defaults: the mode starts at dry.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Mode } from './decide.ts'
import type { ModelSettings } from './model.ts'
import type { Pack } from './prompt.ts'
import type { Settings } from './reply.ts'

export type Secrets = { appSecret: string; verifyToken: string; pageToken: string; modelKey: string; sinkToken: string }
export type Config = { settings: Settings; model: ModelSettings; port: number; packDir: string; sinkUrl: string; linesKeptDays: number }

const MODES: Mode[] = ['off', 'dry', 'team', 'live']
const num = (v: unknown, d: number, min: number) => (typeof v === 'number' && Number.isFinite(v) && v >= min ? v : d)
const text = (v: unknown, d: string) => (typeof v === 'string' ? v : d)

// team and live need ourAppId: without it the bot reads its own echoes as a person and goes quiet after one reply.
export function parseConfig(raw: unknown, dir: string): Config {
  const c = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const l = (c.limits && typeof c.limits === 'object' ? c.limits : {}) as Record<string, unknown>
  const m = (c.model && typeof c.model === 'object' ? c.model : {}) as Record<string, unknown>
  return {
    settings: {
      brand: text(c.brand, 'our business'),
      mode: !MODES.includes(c.mode as Mode) ? 'dry' : (c.mode === 'team' || c.mode === 'live') && !text(c.ourAppId, '').trim() ? 'dry' : c.mode as Mode,
      ourAppId: text(c.ourAppId, '').trim(),
      team: Array.isArray(c.team) ? c.team.filter((x): x is string => typeof x === 'string') : [],
      limits: { repliesPerLeadPerDay: num(l.repliesPerLeadPerDay, 8, 0), humanQuietHours: num(l.humanQuietHours, 72, 0) },
      maxChars: num(c.maxChars, 600, 50),
      historyLines: num(c.historyLines, 20, 1),
      publicCommentLine: text(c.publicCommentLine, ''),
      fallbackReply: text(c.fallbackReply, ''),
    },
    model: { baseUrl: text(m.baseUrl, 'https://api.openai.com/v1'), model: text(m.model, 'gpt-5.4-mini'), timeoutMs: num(m.timeoutMs, 30_000, 1000) },
    port: num(c.port, 8795, 1),
    packDir: text(c.packDir, join(dir, 'pack')),
    sinkUrl: text(c.sinkUrl, ''),
    linesKeptDays: num(c.linesKeptDays, 30, 1),
  }
}

const readJson = (f: string): unknown => { try { return JSON.parse(readFileSync(f, 'utf8')) } catch { return {} } }

export const loadConfig = (dir: string) => parseConfig(readJson(join(dir, 'config.json')), dir)

export function loadSecrets(dir: string): Secrets {
  const s = readJson(join(dir, 'secrets.json')) as Record<string, unknown>
  const get = (k: string) => text(s[k], '')
  return { appSecret: get('appSecret'), verifyToken: get('verifyToken'), pageToken: get('pageToken'), modelKey: get('modelKey'), sinkToken: get('sinkToken') }
}

// Read fresh for every message, so the teacher's newest pack and job apply with no restart.
export function readJobAndPack(dir: string, packDir: string): { job: string; pack: Pack } {
  const read = (f: string) => { try { return readFileSync(f, 'utf8') } catch { return '' } }
  let files: string[] = []
  try { files = readdirSync(packDir).filter(f => f.endsWith('.md') && f !== 'links.md').sort() } catch { /* no pack yet */ }
  const facts = files.map(f => read(join(packDir, f)).trim()).filter(Boolean).join('\n\n')
  // A kagelet's memory notes are .md files, so the links live in links.md: one per line or bullet, a # comment after.
  const links = read(join(packDir, 'links.md')).split('\n').map(l => l.replace(/\s#.*$/, '').replace(/^[-*]\s+/, '').trim()).filter(l => /^https?:\/\/\S+$/.test(l))
  return { job: read(join(dir, 'job.md')), pack: { facts, links } }
}
