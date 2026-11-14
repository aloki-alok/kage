// Kage's own meeting bot (#63): the rules the hub applies to it. The bot is a Chromium on another machine
// that joins a Google Meet, reads Meet's captions and posts them here as speaker lines. Everyone in the call
// is a stranger to Kage, so their words stay data. The routes are connectors/meeting.ts.
import { noChannelTag } from './gate.ts'

const MAX_LINE = 2000      // characters in one caption line; Meet splits long speech into many
const MAX_SEGMENTS = 200   // lines in one post; the bot posts about every second

export type Line = { speaker: string; text: string }

const oneLine = (s: string) => noChannelTag(s).replace(/\s+/g, ' ').trim()

// Only a meet.google.com meeting code, rebuilt from its parts, so the bot never opens anything else.
export function meetLink(s: string): string | undefined {
  const m = /^<?(?:https?:\/\/)?meet\.google\.com\/([a-z]{3}-[a-z]{4}-[a-z]{3})(?:[?#][^\s<>]*)?>?$/i.exec(s.trim())
  return m ? `https://meet.google.com/${m[1]!.toLowerCase()}` : undefined
}

export function parseSegments(raw: unknown): { call: string; lines: Line[] } | undefined {
  const p = (raw ?? {}) as { call?: unknown; segments?: unknown }
  if (typeof p.call !== 'string' || !/^[a-z0-9-]{1,40}$/.test(p.call)) return undefined
  if (!Array.isArray(p.segments) || p.segments.length > MAX_SEGMENTS) return undefined
  const lines: Line[] = []
  for (const s of p.segments as { speaker?: unknown; text?: unknown }[]) {
    const text = typeof s?.text === 'string' ? oneLine(s.text).slice(0, MAX_LINE) : ''
    if (!text) continue
    const speaker = typeof s.speaker === 'string' && oneLine(s.speaker) ? oneLine(s.speaker).slice(0, 60) : 'Someone'
    lines.push({ speaker, text })
  }
  return { call: p.call, lines }
}
