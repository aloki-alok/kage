import type { Page } from 'playwright-core'

export type Pipeline = { api: string; key: string; agent: number }

export async function bridge(page: Page, p: Pipeline, log: (...a: unknown[]) => void, ended = () => {}): Promise<() => void> {
  const r = await fetch(`${p.api}/api/v1/sessions/create`, {
    method: 'POST', headers: { authorization: `Bearer ${p.key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'voice', agent_id: p.agent }),
  })
  const j = await r.json().catch(() => ({})) as { ws_url?: string; data?: { ws_url?: string } }
  const url = j.ws_url ?? j.data?.ws_url
  if (!r.ok || !url) throw new Error(`voice agent session refused (${r.status})`)
  const ws = new WebSocket(url)
  await new Promise<void>((ok, fail) => { ws.onopen = () => ok(); ws.onerror = () => fail(new Error('voice agent socket failed')) })
  log('voice agent connected, agent', p.agent)
  await page.exposeBinding('kageAudio', (_src, b64: string) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'audio', data: b64 })) })
  let frames = 0, speaking = false, quiet: ReturnType<typeof setTimeout> | undefined
  ws.onmessage = e => {
    let m: { event?: string; type?: string; media?: { payload?: unknown }; text?: string; data?: unknown }
    try { m = JSON.parse(String(e.data)) } catch { return }
    if (m.event === 'media' && typeof m.media?.payload === 'string') {
      if (frames === 0 || speaking === false) { speaking = true; void page.evaluate(() => (window as any).__kage.status('speaking')).catch(() => {}) }
      clearTimeout(quiet)
      quiet = setTimeout(() => { speaking = false; void page.evaluate(() => (window as any).__kage.status('listening')).catch(() => {}) }, 800)
      if (++frames === 1 || frames % 100 === 0) log('voice agent audio frames', frames, 'bytes', m.media.payload.length)
      void page.evaluate(b => (window as any).__kage.play(b), m.media.payload).catch(err => log('playing failed:', String(err)))
    }
    else if (m.event === 'user' && typeof m.media?.payload === 'string') { log('heard a turn,', m.media.payload.length, 'chars'); void page.evaluate(l => (window as any).__kage.status('thinking', l), m.media.payload.slice(-160)).catch(() => {}) }
    else if (m.event === 'clear') void page.evaluate(() => (window as any).__kage.clear()).catch(() => {})
    else if (m.event === 'end_call') { log('voice agent ended the call'); ended() }
    else if (!/system_message|^system$|avatar_speaking/.test(m.event ?? '')) log('voice agent event:', String(m.event).slice(0, 40))
  }
  ws.onclose = c => log('voice agent socket closed', c.code)
  page.once('close', () => ws.close())
  await page.evaluate(() => (window as any).__kage.listen())
  return () => ws.close()
}
