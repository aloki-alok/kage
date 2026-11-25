import { createSign } from 'node:crypto'

const API = 'https://api.github.com'
const PAGES = 10
const part = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url')

export function appJwt(id: number, key: string, now = Date.now()): string {
  const iat = Math.floor(now / 1000) - 60
  const signed = `${part({ alg: 'RS256', typ: 'JWT' })}.${part({ iat, exp: iat + 600, iss: String(id) })}`
  return `${signed}.${createSign('RSA-SHA256').update(signed).sign(key).toString('base64url')}`
}

export async function appInstallations(app: { id: number; key: string }, fetchFn: typeof fetch = fetch): Promise<{ id: number; account?: { login?: string } }[]> {
  const headers = { Authorization: `Bearer ${appJwt(app.id, app.key)}`, Accept: 'application/vnd.github+json' }
  const all: { id: number; account?: { login?: string } }[] = []
  let url: string | undefined = `${API}/app/installations?per_page=100`
  for (let page = 0; url && page < PAGES; page++) {
    const r: Response = await fetchFn(url, { headers })
    if (!r.ok) throw new Error(`GitHub refused the app's token listing installations (${r.status})`)
    all.push(...await r.json() as typeof all)
    url = /<([^>]+)>;\s*rel="next"/.exec(r.headers.get('link') ?? '')?.[1]
  }
  return all
}

export class GithubRefused extends Error {
  readonly status: number
  constructor(status: number, message: string) { super(message); this.status = status }
}

export type GithubCall = (method: 'GET' | 'POST' | 'PUT' | 'PATCH', path: string, body?: Record<string, unknown>) => Promise<unknown>
const TOKEN_MARGIN_MS = 300_000

export function installationCall(app: { id: number; key: string }, fetchFn: typeof fetch = fetch, now = Date.now): (installation: number) => GithubCall {
  const tokens = new Map<number, { token: string; until: number }>()
  const token = async (installation: number) => {
    const held = tokens.get(installation)
    if (held && held.until > now()) return held.token
    const r = await fetchFn(`${API}/app/installations/${installation}/access_tokens`, { method: 'POST', headers: { Authorization: `Bearer ${appJwt(app.id, app.key)}`, Accept: 'application/vnd.github+json' } })
    if (!r.ok) throw new GithubRefused(r.status, `GitHub refused an installation token for ${installation} (${r.status})`)
    const got = await r.json() as { token: string; expires_at: string }
    tokens.set(installation, { token: got.token, until: Date.parse(got.expires_at) - TOKEN_MARGIN_MS })
    return got.token
  }
  return installation => async (method, path, body) => {
    const headers: Record<string, string> = { Authorization: `Bearer ${await token(installation)}`, Accept: 'application/vnd.github+json' }
    if (body) headers['Content-Type'] = 'application/json'
    const r = await fetchFn(`${API}${path}`, { method, headers, ...(body && { body: JSON.stringify(body) }) })
    if (!r.ok) throw new GithubRefused(r.status, `GitHub answered ${r.status} to ${method} ${path}`)
    return r.status === 204 ? {} : r.json()
  }
}
