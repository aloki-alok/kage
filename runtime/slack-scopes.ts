// Asks Slack which scopes a token holds: auth.test sends them in the x-oauth-scopes response header.
import { BOT_SCOPES, USER_SCOPES, missingScopes, type Missing } from '../core/slack-scopes.ts'

type Fetch = typeof fetch

export async function authTest(token: string, f: Fetch = fetch): Promise<{ scopes: string[]; botId?: string } | undefined> {
  try {
    const r = await f('https://slack.com/api/auth.test', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) })
    const body = await r.json() as { ok: boolean; bot_id?: string }
    const header = r.headers.get('x-oauth-scopes')
    if (!body.ok || header === null) return undefined
    return { scopes: header.split(',').map(s => s.trim()).filter(Boolean), botId: body.bot_id }
  } catch { return undefined }
}

// What each token lacks. A token Slack will not answer for counts as nothing missing: that is the token check's job to report.
export async function checkScopes(tokens: { user?: string | null; bot?: string | null }, wanted = { bot: BOT_SCOPES, user: USER_SCOPES }, f: Fetch = fetch): Promise<Missing> {
  const one = async (t: string | null | undefined, w: string[]) => { const a = t ? await authTest(t, f) : undefined; return a ? missingScopes(w, a.scopes) : [] }
  return { bot: await one(tokens.bot, wanted.bot), user: await one(tokens.user, wanted.user) }
}
