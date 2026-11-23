import { BOT_SCOPES, USER_SCOPES, missingScopes, withScopes, type Missing } from '../core/slack-scopes.ts'

type Fetch = typeof fetch

export async function authTest(token: string, f: Fetch = fetch): Promise<{ scopes: string[]; botId?: string; teamId?: string } | undefined> {
  try {
    const r = await f('https://slack.com/api/auth.test', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) })
    const body = await r.json() as { ok: boolean; bot_id?: string; team_id?: string }
    const header = r.headers.get('x-oauth-scopes')
    if (!body.ok || header === null) return undefined
    return { scopes: header.split(',').map(s => s.trim()).filter(Boolean), botId: body.bot_id, teamId: body.team_id }
  } catch { return undefined }
}

export async function checkScopes(tokens: { user?: string | null; bot?: string | null }, wanted = { bot: BOT_SCOPES, user: USER_SCOPES }, f: Fetch = fetch): Promise<Missing> {
  const one = async (t: string | null | undefined, w: string[]) => { const a = t ? await authTest(t, f) : undefined; return a ? missingScopes(w, a.scopes) : [] }
  return { bot: await one(tokens.bot, wanted.bot), user: await one(tokens.user, wanted.user) }
}

const slackCall = async (method: string, token: string, args: Record<string, string>, f: Fetch): Promise<Record<string, unknown>> => {
  const r = await f(`https://slack.com/api/${method}`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: new URLSearchParams(args), signal: AbortSignal.timeout(15_000) })
  const body: unknown = await r.json()
  return typeof body === 'object' && body !== null ? body as Record<string, unknown> : { ok: false }
}

export async function addScopes(configToken: string, app: string, m: Missing, f: Fetch = fetch): Promise<{ ok: true } | { ok: false; error: string }> {
  const failed = (b: Record<string, unknown>) => ({ ok: false as const, error: typeof b.error === 'string' ? b.error : 'unknown' })
  try {
    const exported = await slackCall('apps.manifest.export', configToken, { app_id: app }, f)
    if (exported.ok !== true) return failed(exported)
    const manifest = withScopes(exported.manifest, m)
    if (!manifest) return { ok: false, error: 'unreadable_manifest' }
    const updated = await slackCall('apps.manifest.update', configToken, { app_id: app, manifest: JSON.stringify(manifest) }, f)
    return updated.ok === true ? { ok: true } : failed(updated)
  } catch { return { ok: false, error: 'network' } }
}
