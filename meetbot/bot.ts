// Kage's meeting bot (#63). It runs on a machine with a screen (or Xvfb), long-polls the owner's Kage hub for a
// join, drives its own Chromium into the Google Meet, and posts Meet's captions to the hub as speaker lines.
// It only calls out: the hub is reached over the owner's tailnet at the meeting webhook, with the meeting token.
// Everything it knows about Meet's page is page.js. Settings: ~/.config/kage-meetbot/config.json and secrets.json.
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Page } from 'playwright-core'

export type Seg = { speaker: string; text: string; start: number }
type Settings = { hub: string; name: string; consent: string; chrome?: string; profile: string; token: string }

const log = (...a: unknown[]) => console.error(new Date().toISOString(), ...a)
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
export const PAGE_JS = fileURLToPath(new URL('./page.js', import.meta.url))

export function settings(dir = join(homedir(), '.config', 'kage-meetbot')): Settings {
  const read = (f: string) => { try { return JSON.parse(readFileSync(join(dir, f), 'utf8')) as Record<string, unknown> } catch { return {} } }
  const c = read('config.json'), s = read('secrets.json')
  const str = (v: unknown, d = '') => typeof v === 'string' && v.trim() ? v.trim() : d
  const hub = str(c.hub).replace(/\/+$/, '')
  if (!/^https?:\/\/[^\s/]+$/.test(hub)) throw new Error(`config.json: hub must be the hub's address, like http://my-mac:8790 (got "${hub}")`)
  const token = str(s.meetingToken)
  if (!token) throw new Error('secrets.json: meetingToken is missing (the same token as the hub\'s meetingToken)')
  const name = str(c.name, 'Kage (notes)')
  return {
    hub, token, name, chrome: str(c.chrome) || undefined, profile: str(c.profile, join(dir, 'chromium')),
    consent: str(c.consent, `${name} is taking notes for the meeting, and answers out loud when you say ${name.split(' ')[0]}.`),
  }
}

// One call, start to end, on a page Kage already opened. Resolves with everything heard once the call is over.
export async function attend(page: Page, link: string, o: {
  name: string; consent: string
  heard: (lines: Seg[]) => Promise<void> | void   // settled caption lines, about once a second
  admitMs?: number   // how long to wait for the host to let Kage in
  aloneMs?: number   // with nobody else in the call this long, Kage leaves
  stop?: () => boolean
}): Promise<Seg[]> {
  const admitMs = o.admitMs ?? 10 * 60_000, aloneMs = o.aloneMs ?? 2 * 60_000
  const k = <T>(fn: string, arg?: unknown) => page.evaluate(([f, a]) => (window as any).__kage[f as string](a), [fn, arg] as const) as Promise<T>
  const mark = (kind: string) => k<boolean>('mark', kind)
  const click = async (kind: string) => (await mark(kind)) && (await page.click(`[data-kage="${kind}"]`), true)
  const until = async (what: () => Promise<boolean>, ms: number) => { for (const end = Date.now() + ms; Date.now() < end; await sleep(500)) if (await what()) return true; return false }

  await page.goto(link, { waitUntil: 'domcontentloaded' })
  // A signed-in profile has no name field; a guest types the name everyone in the call will see.
  if (await until(() => mark('name'), 15_000)) await page.fill('[data-kage="name"]', o.name)
  if (!await until(() => click('join'), 30_000)) throw new Error('no join button on the Meet page')
  log('asked to join', link)
  const admitted = await until(async () => {
    await click('noticeJoin')   // "someone else in this call takes notes": every joiner clicks Join now
    const s = await k<string>('state')
    if (s === 'refused' || s === 'ended') throw new Error(`Meet did not let Kage in (${s})`)
    return s === 'in'
  }, admitMs)
  if (!admitted) throw new Error('nobody let Kage in')
  log('in the call')

  // The consent line, before anything is heard.
  if (await until(async () => (await mark('chatBox')) || (await click('chatOpen'), false), 10_000)) {
    await page.fill('[data-kage="chatBox"]', o.consent)
    await page.press('[data-kage="chatBox"]', 'Enter')
  } else log('no chat box: the consent line was not posted')
  if (!await click('captionsOn')) await page.keyboard.press('c')   // Meet's shortcut for captions

  const all: Seg[] = []
  const t0 = Date.now()
  let lastCompany = Date.now()
  while (!o.stop?.()) {
    await sleep(1000)
    if (page.isClosed()) break
    const lines = await k<{ speaker: string; text: string }[]>('settled').catch(() => [])
    if (lines.length) {
      const segs = lines.map(l => ({ ...l, start: Math.round((Date.now() - t0) / 1000) }))
      all.push(...segs)
      await Promise.resolve(o.heard(segs)).catch(e => log('posting lines failed', String(e)))
    }
    const s = await k<string>('state').catch(() => 'ended')
    if (s === 'ended' || s === 'refused') break
    if (await k<number>('others').catch(() => -1) !== 0) lastCompany = Date.now()
    else if (Date.now() - lastCompany >= aloneMs) { log('alone in the call, leaving'); await click('leave').catch(() => {}); break }
  }
  log('call over', all.length, 'lines')
  return all
}

// The hub's meeting webhook, with the token.
export function hub(s: Pick<Settings, 'hub' | 'token'>) {
  const auth = { authorization: `Bearer ${s.token}`, 'content-type': 'application/json' }
  return {
    next: async (after: number) => {
      const r = await fetch(`${s.hub}/meetbot/next?after=${after}`, { headers: auth, signal: AbortSignal.timeout(40_000) })
      if (r.status === 204) return []
      if (!r.ok) throw new Error(`hub said ${r.status}`)
      return await r.json() as { seq: number; op: string; link: string }[]
    },
    lines: async (call: string, segments: Seg[]) => {
      const r = await fetch(`${s.hub}/meetbot/segments`, { method: 'POST', headers: auth, body: JSON.stringify({ call, segments }) })
      if (!r.ok) throw new Error(`hub said ${r.status}`)
    },
  }
}

export const callId = (link: string) => new URL(link).pathname.slice(1)

// One call at a time: a join that comes during a call waits for the next poll after it.
async function main() {
  const s = settings()
  const h = hub(s)
  log(`meeting bot up, hub ${s.hub}`)
  let after = 0
  for (;;) {
    let cmds: Awaited<ReturnType<typeof h.next>>
    try { cmds = await h.next(after) } catch (e) { log('hub unreachable:', String(e)); await sleep(5000); continue }
    for (const c of cmds) {
      after = Math.max(after, c.seq)
      if (c.op !== 'join' || !/^https:\/\/meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}$/.test(c.link)) continue
      const ctx = await chromium.launchPersistentContext(s.profile, {
        headless: false, executablePath: s.chrome, viewport: { width: 1280, height: 800 },
        args: ['--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required', '--disable-blink-features=AutomationControlled'],
        ignoreDefaultArgs: ['--enable-automation'],
      })
      try {
        await ctx.addInitScript({ path: PAGE_JS })
        const page = ctx.pages()[0] ?? await ctx.newPage()
        const call = callId(c.link)
        await attend(page, c.link, { name: s.name, consent: s.consent, heard: segs => h.lines(call, segs) })
      } catch (e) { log('call failed:', String(e)) } finally { await ctx.close().catch(() => {}) }
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) void main()
