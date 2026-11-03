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

// Slack caps a message near 40k chars but long blocks render badly; split on lines.
export function splitForSlack(text: string, max = 3500): string[] {
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
