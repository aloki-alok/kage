// A voice agent's web call as Kage's ears and mouth in a Meet: the call's audio goes to the agent, the agent's
// voice comes back into Kage's mic. The agent hears, takes turns and speaks; Kage answers through its ask_kage tool.
// Protocol: POST /api/v1/sessions/create gives a ws_url; 16 kHz PCM16 base64 both ways ({type:"audio"} in,
// {event:"media"} out, {event:"clear"} when someone cuts in, {event:"end_call"} when the agent hangs up).
import type { Page } from 'playwright-core'

// ownerCode: the hub's one-time code when the owner sent Kage in; the agent hands it to ask_kage, as on a phone call.
export type Pipeline = { api: string; key: string; agent: number; ownerCode?: string }

export async function bridge(page: Page, p: Pipeline, log: (...a: unknown[]) => void, ended = () => {}): Promise<() => void> {
  const r = await fetch(`${p.api}/api/v1/sessions/create`, {
    method: 'POST', headers: { authorization: `Bearer ${p.key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'voice', agent_id: p.agent, ...(p.ownerCode && { custom_variables: { owner_code: p.ownerCode }, call_context: { owner_code: p.ownerCode } }) }),
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
    else if (m.event === 'user' && typeof m.media?.payload === 'string') { log('heard:', m.media.payload.slice(-120)); void page.evaluate(l => (window as any).__kage.status('thinking', l), m.media.payload.slice(-160)).catch(() => {}) }
    else if (m.event === 'clear') void page.evaluate(() => (window as any).__kage.clear()).catch(() => {})
    else if (m.event === 'end_call') { log('voice agent ended the call'); ended() }
    else if (!/system_message|^system$|avatar_speaking/.test(m.event ?? '')) log('voice agent:', JSON.stringify(m).slice(0, 200))
  }
  ws.onclose = c => log('voice agent socket closed', c.code)
  page.once('close', () => ws.close())   // however the call ends, the agent's call ends with it
  await page.evaluate(() => (window as any).__kage.listen())
  return () => ws.close()
}
