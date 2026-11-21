import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'

const tag = () => randomBytes(6).toString('hex')
const TOKENS = { app: `xapp-1-REHEARSAL-${tag()}`, user: `xoxp-rehearsal-${tag()}`, bot: `xoxb-rehearsal-${tag()}` }
const ANSWERS: Record<string, Record<string, unknown>> = {
  [TOKENS.app]: { ok: true, url: 'wss://rehearsal.invalid/link' },
  [TOKENS.user]: { ok: true, user_id: 'U0REHEARSAL' },
  [TOKENS.bot]: { ok: true, user_id: 'U0REHEARSALBOT' },
}

const appName = (url: URL) => {
  try {
    const m = JSON.parse(url.searchParams.get('manifest_json') ?? '{}')
    return String(m?.features?.bot_user?.display_name ?? m?.display_information?.name ?? 'kage')
  } catch { return 'kage' }
}

const page = (name: string) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Rehearsal Slack</title>
<style>
body{font:15px/1.5 -apple-system,system-ui,sans-serif;background:#f4ede4;color:#1d1c1d;margin:0;padding:40px 16px}
main{max-width:640px;margin:auto;background:#fff;border:1px solid #ddd;border-radius:8px;padding:28px}
.note{background:#fff4d6;border:1px solid #e8c766;padding:8px 12px;border-radius:6px;margin-bottom:20px;font-size:13px}
button{font:600 14px system-ui;background:#007a5a;color:#fff;border:0;border-radius:4px;padding:9px 16px;cursor:pointer}
code{display:block;font:13px ui-monospace,Menlo,monospace;background:#f8f8f8;border:1px solid #ddd;padding:10px;margin:6px 0 4px;word-break:break-all}
.step{margin:18px 0}.step[hidden]{display:none}h2{font-size:16px;margin:0 0 6px}
</style>
<main>
<div class="note">Rehearsal: a stand-in for Slack on this Mac. Nothing here reaches a real workspace.</div>
<h1>Create an app: @${name.replace(/[^a-z0-9-]/gi, '')}</h1>
<div class="step" id="s1"><p>Your workspace: <b>Rehearsal Workspace</b></p><button id="create">Next, then Create</button></div>
<div class="step" id="s2" hidden><h2>Basic Information › App-Level Tokens</h2><p>Scope <b>connections:write</b>, generated.</p><code>${TOKENS.app}</code><button id="install">Install App › Allow</button></div>
<div class="step" id="s3" hidden><h2>Install App › OAuth Tokens</h2><p>User OAuth Token</p><code>${TOKENS.user}</code><p>Bot User OAuth Token</p><code>${TOKENS.bot}</code><p>Copy all three into the setup window.</p></div>
</main>
<script>
document.getElementById('create').onclick=()=>{document.getElementById('s2').hidden=false;document.getElementById('create').disabled=true}
document.getElementById('install').onclick=()=>{document.getElementById('s3').hidden=false;document.getElementById('install').disabled=true}
</script>`

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
    const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/, '')
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(ANSWERS[token] ?? { ok: false, error: 'invalid_auth' }))
    return
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(page(appName(url)))
})
server.listen(0, '127.0.0.1', () => {
  const addr = server.address()
  console.log(typeof addr === 'object' && addr ? addr.port : 0)
})
