// Kage's meeting bot (#63). It runs on a machine with a screen (or Xvfb), long-polls the owner's Kage hub for a
// join, drives its own Chromium into the Google Meet, and posts Meet's captions to the hub as speaker lines.
// It only calls out: the hub is reached over the owner's tailnet at the meeting webhook, with the meeting token.
// Everything it knows about Meet's page is page.js. Settings: ~/.config/kage-meetbot/config.json and secrets.json.
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Page } from 'playwright-core'

// What the hub sends (connectors/meeting.ts): go to a call, or speak an answer in it.
export type Cmd = { seq: number; op: 'join'; link: string } | { seq: number; op: 'say'; call: string; text: string }
export type Seg = { speaker: string; text: string; start: number; self?: boolean }
type Settings = { hub: string; name: string; consent: string; chrome?: string; profile: string; token: string; speak?: string; window?: boolean; voice?: string }

const log = (...a: unknown[]) => console.error(new Date().toISOString(), ...a)
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
export const PAGE_JS = fileURLToPath(new URL('./page.js', import.meta.url))

export function settings(dir = join(homedir(), '.config', 'kage-meetbot')): Settings {
  const read = (f: string) => { try { return JSON.parse(readFileSync(join(dir, f), 'utf8')) as Record<string, unknown> } catch { return {} } }
  const c = read('config.json'), s = read('secrets.json')
  const str = (v: unknown, d = '') => typeof v === 'string' && v.trim() ? v.trim() : d
  // The hub passes its own address and token when it runs the bot as its child (router.ts meetbot).
  const hub = str(process.env.KAGE_MEETBOT_HUB || c.hub).replace(/\/+$/, '')
  if (!/^https?:\/\/[^\s/]+$/.test(hub)) throw new Error(`config.json: hub must be the hub's address, like http://my-mac:8790 (got "${hub}")`)
  const token = str(process.env.KAGE_MEETBOT_TOKEN || s.meetingToken)
  if (!token) throw new Error('secrets.json: meetingToken is missing (the same token as the hub\'s meetingToken)')
  const name = str(c.name, 'Kage (notes)')
  return {
    hub, token, name, chrome: str(c.chrome) || undefined, profile: str(c.profile, join(dir, 'chromium')), speak: str(c.speak) || undefined, window: c.window === true, voice: str(c.voice) || undefined,
    consent: str(c.consent, `${name} is taking notes for the meeting, and answers out loud when you say ${name.split(' ')[0]}.`),
  }
}

// One call, start to end, on a page Kage already opened. Resolves with everything heard once the call is over.
export async function attend(page: Page, link: string, o: {
  name: string; consent: string
  heard: (lines: Seg[]) => Promise<void> | void   // settled caption lines, about once a second
  said?: string[]    // Kage's answers waiting to be spoken, filled by the poll loop
  speak?: (text: string) => Promise<Buffer>   // text to WAV audio; with none, the answer goes in the Meet chat
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
  // A signed-in profile shows Join at once; only a guest gets a name field. Wait for whichever comes first.
  await until(async () => (await mark('name')) || (await mark('join')), 15_000)
  if (await mark('name')) await page.fill('[data-kage="name"]', o.name)
  if (!await until(async () => (await click('blocker'), click('join')), 30_000)) {
    const d = await k<string>('dialog')
    throw new Error(d ? `a Meet popup is in the way: ${d}` : 'no join button on the Meet page')
  }
  log('asked to join', link)
  const admitted = await until(async () => {
    await click('noticeJoin')   // "someone else in this call takes notes": every joiner clicks Join now
    const s = await k<string>('state')
    if (s === 'refused' || s === 'ended') throw new Error(`Meet did not let Kage in (${s})`)
    return s === 'in'
  }, admitMs)
  if (!admitted) throw new Error('nobody let Kage in')
  log('in the call')

  const chat = async (text: string) => {
    if (!await until(async () => (await mark('chatBox')) || (await click('chatOpen'), false), 10_000)) return false
    await page.fill('[data-kage="chatBox"]', text)
    await page.press('[data-kage="chatBox"]', 'Enter')
    return true
  }
  // The consent line, before anything is heard.
  if (!await chat(o.consent)) log('no chat box: the consent line was not posted')
  await click('micOn')   // Meet may let a guest in muted
  if (!await click('captionsOn')) await page.keyboard.press('c')   // Meet's shortcut for captions

  const all: Seg[] = []
  const t0 = Date.now()
  let lastCompany = Date.now(), captionsChecked = false
  while (!o.stop?.()) {
    await sleep(1000)
    if (page.isClosed()) break
    for (const text of o.said?.splice(0) ?? []) {
      let spoken = false
      log('saying:', text.slice(0, 120))
      if (o.speak) try { await k('say', (await o.speak(text)).toString('base64')); spoken = true } catch (e) { log('speaking failed, posting in chat:', String(e)) }
      if (!spoken) await chat(text).catch(() => false)
    }
    const lines = await k<{ speaker: string; text: string }[]>('settled').catch(() => [])
    if (lines.length) {
      // Meet labels the bot's own speech "You"; it is kept for the notes and marked, so it never wakes Kage.
      const segs = lines.map(l => ({ ...l, ...(l.speaker === 'You' || l.speaker === o.name ? { speaker: o.name, self: true } : {}), start: Math.round((Date.now() - t0) / 1000) }))
      all.push(...segs)
      for (const l of segs) log('heard', `${l.speaker}:`, l.text.slice(0, 160))
      await Promise.resolve(o.heard(segs)).catch(e => log('posting lines failed', String(e)))
    }
    if (!all.length && !captionsChecked && Date.now() - t0 > 20_000) {
      captionsChecked = true
      log(await k<boolean>('captionsShown') ? 'captions are on, nobody has spoken yet' : 'no captions on the page after 20 s: Meet may have moved its captions')
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
      return await r.json() as Cmd[]
    },
    lines: async (call: string, segments: Seg[]) => {
      const r = await fetch(`${s.hub}/meetbot/segments`, { method: 'POST', headers: auth, body: JSON.stringify({ call, segments }) })
      if (!r.ok) throw new Error(`hub said ${r.status}`)
    },
    // The call is over: its live session ends, and the whole transcript goes to the notes webhook (/meeting).
    ended: async (call: string, link: string, segments: Seg[]) => {
      await fetch(`${s.hub}/meetbot/ended`, { method: 'POST', headers: auth, body: JSON.stringify({ call }) }).catch(() => {})
      if (!segments.length) return
      const r = await fetch(`${s.hub}/meeting`, { method: 'POST', headers: auth, body: JSON.stringify({ title: `Meet ${call}`, link, segments }) })
      if (!r.ok) throw new Error(`hub said ${r.status} to the transcript`)
    },
  }
}

export const callId = (link: string) => new URL(link).pathname.slice(1)

// Built-in speech when the hub passes a Cartesia key (secrets.json cartesiaKey): one request per answer, WAV back.
const cartesia = (key: string, voice = '47c38ca4-5f35-497b-b1a3-415245fb35e1') => async (text: string) => {
  const r = await fetch('https://api.cartesia.ai/tts/bytes', {
    method: 'POST', headers: { 'X-API-Key': key, 'Cartesia-Version': '2025-04-16', 'content-type': 'application/json' },
    body: JSON.stringify({ model_id: 'sonic-2', transcript: text, voice: { mode: 'id', id: voice }, language: 'en', output_format: { container: 'wav', encoding: 'pcm_s16le', sample_rate: 24000 } }),
  })
  if (!r.ok) throw new Error(`cartesia ${r.status}`)
  return Buffer.from(await r.arrayBuffer())
}
// speak: a command that reads text on stdin and writes WAV audio to stdout (any TTS, or a voice pipeline's).
export const speaker = (cmd: string) => (text: string) => new Promise<Buffer>((ok, fail) => {
  const p = spawn(cmd, { shell: true, stdio: ['pipe', 'pipe', 'inherit'] })
  const out: Buffer[] = []
  p.stdout.on('data', (b: Buffer) => out.push(b))
  p.on('error', fail)
  p.on('close', code => code === 0 && out.length ? ok(Buffer.concat(out)) : fail(new Error(`speak exited ${code}`)))
  p.stdin.end(text)
})

// The poll loop never waits on a call, so answers reach the call while it runs. One call at a time:
// a join that comes during a call is dropped, with a log line.
async function main() {
  const s = settings()
  const h = hub(s)
  log(`meeting bot up, hub ${s.hub}`)
  let current: { call: string; said: string[] } | undefined
  let after = 0
  for (;;) {
    let cmds: Awaited<ReturnType<typeof h.next>>
    try { cmds = await h.next(after) } catch (e) { log('hub unreachable:', String(e)); await sleep(5000); continue }
    for (const c of cmds) {
      after = Math.max(after, c.seq)
      if (c.op === 'say') { if (current && current.call === c.call) current.said.push(c.text); continue }
      if (!/^https:\/\/meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}$/.test(c.link)) continue
      if (current) { log('already in a call, not joining', c.link); continue }
      const call = { call: callId(c.link), said: [] as string[] }
      current = call
      void runCall(s, h, c.link, call).finally(() => { current = undefined })
    }
  }
}

async function runCall(s: Settings, h: ReturnType<typeof hub>, link: string, call: { call: string; said: string[] }) {
  // Chrome's new headless mode, with no window on the owner's screen. Meet turned away the old headless mode,
  // and the user agent names HeadlessChrome, so it reads as the plain Chrome it is. "window": true shows it.
  const ua = s.window ? undefined : `Mozilla/5.0 (${process.platform === 'darwin' ? 'Macintosh; Intel Mac OS X 10_15_7' : 'X11; Linux x86_64'}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromium.version?.() ?? '140.0.0.0'} Safari/537.36`
  const ctx = await chromium.launchPersistentContext(s.profile, {
    headless: !s.window, executablePath: s.chrome, viewport: { width: 1280, height: 800 }, ...(ua && { userAgent: ua }),
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required', '--disable-blink-features=AutomationControlled', ...(s.window ? [] : ['--headless=new'])],
    ignoreDefaultArgs: ['--enable-automation'],
  })
  let all: Seg[] = []
  try {
    await ctx.addInitScript({ path: PAGE_JS })
    const page = ctx.pages()[0] ?? await ctx.newPage()
    all = await attend(page, link, { name: s.name, consent: s.consent, said: call.said, speak: s.speak ? speaker(s.speak) : process.env.KAGE_MEETBOT_CARTESIA ? cartesia(process.env.KAGE_MEETBOT_CARTESIA, s.voice) : undefined, heard: segs => h.lines(call.call, segs) })
  } catch (e) { log('call failed:', String(e)) } finally { await ctx.close().catch(() => {}) }
  await h.ended(call.call, link, all).catch(e => log('notes not sent:', String(e)))
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) void main()
