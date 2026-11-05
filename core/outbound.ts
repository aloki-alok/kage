// What may go out: crowd and person mentions, secrets, Slack-sized parts.

// Replies never ping a crowd, whatever the model writes. A person is pinged only when `ping` is
// set (the owner's own task); otherwise the mention becomes a plain @name.
export function safeReply(text: string, o: { ping?: boolean; names?: Record<string, string> } = {}): string {
  // User groups (<!subteam^S1|@devs>) are crowds too.
  const out = text.replace(/<!(channel|here|everyone)[^>]*>/g, '$1')
    .replace(/<!subteam\^[A-Z0-9]+(?:\|@?([^>]*))?>/g, (_, label?: string) => `@${label || 'group'}`)
  // <@U1> and the labelled <@U1|bob> both notify.
  return o.ping ? out : out.replace(/<@([A-Z0-9]+)(?:\|[^>]*)?>/g, (_, id: string) => `@${o.names?.[id] ?? id}`)
}

// Text rules alone did not stop a password reaching a thread (2026-11-01), so the reply tool
// checks. A hit sends the reply back with a hint to use private=true; a false alarm costs one retry.
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
  // A strong-password-shaped code span (upper, lower and digit) near the word password or secret.
  let prev = ''
  for (const line of text.split('\n')) {
    const near = `${prev} ${line}`
    prev = line
    if (!/pass(word|wd)|secret|credential/i.test(near)) continue
    for (const [, span = ''] of line.matchAll(/`([^`\s]{10,})`/g))
      if (/[A-Z]/.test(span) && /[a-z]/.test(span) && /\d/.test(span)) return 'password'
  }
}

// Whether a reply may go out as written. The owner may let a secret into a thread by asking;
// a teammate's task never can, whatever the reply claims.
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

// Slack caps a message near 40k chars but long blocks render badly; split on lines. A cut inside a
// ``` block closes it and reopens it in the next part, or that part shows in a proportional font.
export function splitForSlack(text: string, max = 3500): string[] {
  const parts = splitLines(text, Math.max(1, max - 2 * (FENCE.length + 1)))
  let open = false
  return parts.map(p => {
    const part = open ? `${FENCE}\n${p}` : p
    open = isOpen(part)
    // A cut next to a fence line would leave an empty block (```\n```): drop the pair.
    return (open ? `${part}\n${FENCE}` : part).replace(/^```\n```(\n|$)/, '').replace(/(^|\n)```\n```$/, '')
  }).filter(Boolean)
}

// A thread panel fits about 64 characters of Slack's code font. A longer row wraps, and its last
// column lands under the row as if it were the next row (measured 2026-11-05: Monaco 12px, 500 px).
export const CODE_WIDTH = 60
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
