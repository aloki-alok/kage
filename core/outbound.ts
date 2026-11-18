
export function safeReply(text: string): string {
  return text.replace(/<!(channel|here|everyone)[^>]*>/g, '$1')
    .replace(/<!subteam\^[A-Z0-9]+(?:\|@?([^>]*))?>/g, (_, label?: string) => `@${label || 'group'}`)
}

const SECRET_SHAPES: [string, RegExp][] = [
  ['AWS access key', /\b(AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['Slack token', /\bxox[abprs]-[0-9A-Za-z-]{10,}/],
  ['GitHub token', /\b(gh[pousr]_[0-9A-Za-z]{30,}|github_pat_\w{20,})/],
  ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['API key', /\bsk-(proj-|ant-)?[\w-]{20,}/],
  ['secret assignment', /\b\w*(secret|token|password|passwd|api_?key)\w*\s*[=:]\s*['"]?[^\s'"`]{12,}/i],
]

export function findSecret(text: string): string | undefined {
  for (const [name, shape] of SECRET_SHAPES) if (shape.test(text)) return name
  let prev = ''
  for (const line of text.split('\n')) {
    const near = `${prev} ${line}`
    prev = line
    if (!/pass(word|wd)|secret|credential/i.test(near)) continue
    for (const [, span = ''] of line.matchAll(/`([^`\s]{10,})`/g))
      if (/[A-Z]/.test(span) && /[a-z]/.test(span) && /\d/.test(span)) return 'password'
  }
}

export function secretRefusal(
  text: string, o: { private?: boolean; ownerAsked?: boolean; fromOwner: boolean },
): string | undefined {
  if (o.private) return
  const secret = findSecret(text)
  if (!secret || (o.ownerAsked && o.fromOwner)) return
  return o.fromOwner
    ? `refused: this looks like a ${secret}, and threads are seen by others. Send it with private=true, or set owner_asked=true only if the owner's own task line asks for it in the thread.`
    : `refused: this looks like a ${secret}, and this task is from a teammate. Send the secret to the owner with private=true.`
}

const FENCE = '```'
const isOpen = (s: string) => s.split(FENCE).length % 2 === 0

export function splitForSlack(text: string, max = 3500): string[] {
  const parts = splitLines(text, Math.max(1, max - 2 * (FENCE.length + 1)))
  let open = false
  return parts.map(p => {
    const part = open ? `${FENCE}\n${p}` : p
    open = isOpen(part)
    return (open ? `${part}\n${FENCE}` : part).replace(/^```\n```(\n|$)/, '').replace(/(^|\n)```\n```$/, '')
  }).filter(Boolean)
}

const CODE_WIDTH = 60
export function layoutRefusal(text: string, o: { wide?: boolean } = {}): string | undefined {
  if (o.wide) return
  const rows = text.split(FENCE).filter((_, i) => i % 2 === 1).flatMap(b => b.split('\n'))
  const long = rows.filter(r => r.length > CODE_WIDTH)
  if (!long.length) return
  const worst = long.reduce((a, b) => (b.length > a.length ? b : a))
  return `not sent: ${long.length} lines inside a code block are wider than ${CODE_WIDTH} characters, so they wrap in the Slack thread panel and the columns run together. Widest (${worst.length}): ${worst.trim()}\nNarrow the table: drop columns the reader does not need, cut names to about 20 characters, shorten bars. A long table goes in a file with send_file. Pass wide=true only for a log or code, never a table.`
}

function splitLines(text: string, max: number): string[] {
  const parts: string[] = []
  let cur = ''
  for (const line of text.split('\n')) {
    const next = cur ? `${cur}\n${line}` : line
    if (next.length <= max) {
      cur = next
      continue
    }
    if (cur) parts.push(cur)
    let rest = line
    while (rest.length > max) {
      parts.push(rest.slice(0, max))
      rest = rest.slice(max)
    }
    cur = rest
  }
  parts.push(cur)
  return parts
}

export const slackPlain = (t: string) => t.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')

export function guardVerdict(out: string): { send: boolean; reason: string } {
  const line = out.trim().split('\n')[0] ?? ''
  if (/^SEND\.?$/i.test(line.trim())) return { send: true, reason: '' }
  return { send: false, reason: line.replace(/^HOLD:?\s*/i, '') || 'no verdict' }
}

export const FOOTER_ID = 'kage-footer'
export type Signer = { asked?: string; from?: string; via?: string }
export const kageFooter = (title: string, s: Signer = {}) =>
  `🥷 ${title}${s.via ? ` · ${s.via}` : ''}${s.asked ? ` · asked by ${s.asked}` : s.from ? ` · from ${s.from}` : ''}`

export function ownerPost(title: string, typed: string, s: Signer = {}) {
  const foot = kageFooter(title, s)
  const name = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const text = typed.replace(new RegExp(`\\s*_?(?:🥷|:ninja:) ${name}(?: · [^\\n]*?)?_?\\s*$`, 'u'), '')
  const blocks: Record<string, unknown>[] = splitForSlack(text, 3000).map(t => ({ type: 'section', text: { type: 'mrkdwn', text: t } }))
  blocks.push({ type: 'context', block_id: FOOTER_ID, elements: [{ type: 'mrkdwn', text: foot }] })
  return { text: `${text}\n_${foot}_`, blocks }
}

