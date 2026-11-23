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
