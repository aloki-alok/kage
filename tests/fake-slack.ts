import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'

const tag = () => randomBytes(6).toString('hex')
const TOKENS = { app: `xapp-1-REHEARSAL-${tag()}`, user: `xoxp-rehearsal-${tag()}`, bot: `xoxb-rehearsal-${tag()}` }
const ANSWERS: Record<string, Record<string, unknown>> = {
  [TOKENS.app]: { ok: true, url: 'wss://rehearsal.invalid/link' },
  [TOKENS.user]: { ok: true, user_id: 'U0REHEARSAL' },
  [TOKENS.bot]: { ok: true, user_id: 'U0REHEARSALBOT' },
}

const fromManifest = (url: URL) => {
  try {
    const m = JSON.parse(url.searchParams.get('manifest_json') ?? '{}')
    const scopes = [...(m?.oauth_config?.scopes?.bot ?? []), ...(m?.oauth_config?.scopes?.user ?? [])].map(String)
    return { name: String(m?.display_information?.name ?? 'Kage').replace(/[^A-Za-z0-9 -]/g, ''), scopes: [...new Set(scopes)].map(x => x.replace(/[^a-z.:_]/g, '')) }
  } catch { return { name: 'Kage', scopes: [] } }
}

const page = (name: string, scopes: string[]) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Rehearsal: create an app</title>
<style>
body{font:15px/1.5 -apple-system,system-ui,sans-serif;background:#f8f8f8;color:#1d1c1d;margin:0}*{box-sizing:border-box}
.bar{background:#3f0e40;color:#fff;padding:10px 20px;font-size:13px;display:flex;justify-content:space-between}
.bar b{font-weight:700}.tag{background:#ecb22e;color:#1d1c1d;border-radius:4px;padding:1px 8px;font-weight:700}
.wrap{display:flex;min-height:calc(100vh - 41px)}nav{width:230px;background:#fff;border-right:1px solid #e2e2e2;padding:18px 0;font-size:14px}
nav h4{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#616061;margin:16px 20px 6px}
nav a{display:block;padding:5px 20px;color:#1d1c1d;text-decoration:none}nav a.on{background:#1264a3;color:#fff}
main{flex:1;padding:28px 40px;max-width:820px}h1{font-size:28px;margin:0 0 6px}h2{font-size:18px;margin:26px 0 8px}
.card{background:#fff;border:1px solid #e2e2e2;border-radius:8px;padding:18px 20px;margin:12px 0}
.btn{font:700 14px system-ui;background:#007a5a;color:#fff;border:0;border-radius:4px;padding:9px 16px;cursor:pointer}
.btn.ghost{background:#fff;color:#1d1c1d;border:1px solid #bbb}.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.tok{font:13px ui-monospace,Menlo,monospace;background:#f4f4f4;border:1px solid #ddd;border-radius:4px;padding:8px 10px;flex:1;min-width:280px;word-break:break-all}
.modal{position:fixed;inset:0;background:#0008;display:flex;align-items:center;justify-content:center}.modal[hidden]{display:none}
.box{background:#fff;border-radius:8px;width:min(560px,92vw);padding:24px}.muted{color:#616061;font-size:13px}
select,input{font:15px system-ui;padding:8px;border:1px solid #bbb;border-radius:4px;width:100%}
.scope{display:inline-block;font:12px ui-monospace,Menlo,monospace;background:#f4f4f4;border-radius:3px;padding:1px 6px;margin:2px}
[data-view]{display:none}[data-view].on{display:block}
</style>
<div class="bar"><span><b>Rehearsal Workspace</b> · app settings</span><span class="tag">rehearsal: nothing reaches a real Slack</span></div>
<div class="modal" id="m-pick"><div class="box"><h2 style="margin-top:0">Create an app from a manifest</h2>
<p class="muted">Pick a workspace to develop your app in:</p><select><option>Rehearsal Workspace</option></select>
<p></p><div class="row" style="justify-content:flex-end"><button class="btn" data-go="m-review">Next</button></div></div></div>
<div class="modal" id="m-review" hidden><div class="box"><h2 style="margin-top:0">Review summary &amp; create your app</h2>
<p><b>${name}</b> · Socket Mode on</p><p class="muted">Scopes it asks for:</p><div>${scopes.map(x => `<span class="scope">${x}</span>`).join('')}</div>
<p></p><div class="row" style="justify-content:flex-end"><button class="btn ghost" data-go="m-pick">Back</button><button class="btn" data-go="basic">Create</button></div></div></div>
<div class="modal" id="m-gen" hidden><div class="box"><h2 style="margin-top:0">Generate an app-level token</h2>
<p class="muted">Token Name</p><input value="socket">
<p class="muted">Scope</p><div><span class="scope">connections:write</span></div>
<p></p><div class="row" style="justify-content:flex-end"><button class="btn" id="gen">Generate</button></div>
<div id="gen-done" hidden><h2>Your app-level token</h2><div class="row"><div class="tok">${TOKENS.app}</div><button class="btn ghost copy">Copy</button></div>
<p></p><div class="row" style="justify-content:flex-end"><button class="btn" data-go="basic">Done</button></div></div></div></div>
<div class="modal" id="m-allow" hidden><div class="box"><h2 style="margin-top:0">${name} is requesting permission to access the Rehearsal Workspace</h2>
<p class="muted">It can read messages and post as you and as itself.</p><div class="row" style="justify-content:flex-end"><button class="btn ghost" data-go="install">Cancel</button><button class="btn" id="allow">Allow</button></div></div></div>
<div class="wrap"><nav><h4>Settings</h4><a href="#" data-go="basic" id="n-basic">Basic Information</a><a href="#">Socket Mode</a><a href="#" data-go="install" id="n-install">Install App</a><h4>Features</h4><a href="#">OAuth &amp; Permissions</a><a href="#">Event Subscriptions</a></nav>
<main><section data-view="basic"><h1>Basic Information</h1><div class="card"><h2 style="margin-top:0">App-Level Tokens</h2>
<p class="muted">Tokens that let your app connect over Socket Mode.</p><button class="btn ghost" data-go="m-gen">Generate Token and Scopes</button></div></section>
<section data-view="install"><h1>Install App</h1><div class="card" id="install-ask"><p>Install your app to the Rehearsal Workspace to make tokens.</p><button class="btn" data-go="m-allow">Install to Rehearsal Workspace</button></div>
<div id="installed" hidden><div class="card"><h2 style="margin-top:0">User OAuth Token</h2><div class="row"><div class="tok">${TOKENS.user}</div><button class="btn ghost copy">Copy</button></div></div>
<div class="card"><h2 style="margin-top:0">Bot User OAuth Token</h2><div class="row"><div class="tok">${TOKENS.bot}</div><button class="btn ghost copy">Copy</button></div></div></div></section></main></div>
<script>
const show = id => {
  document.querySelectorAll('.modal').forEach(m => { m.hidden = m.id !== id })
  if (!id.startsWith('m-')) { document.querySelectorAll('[data-view]').forEach(v => v.classList.toggle('on', v.dataset.view === id)); document.querySelectorAll('nav a').forEach(a => a.classList.toggle('on', a.dataset.go === id)) }
}
document.querySelectorAll('[data-go]').forEach(b => b.onclick = e => { e.preventDefault(); show(b.dataset.go) })
document.getElementById('gen').onclick = () => { document.getElementById('gen-done').hidden = false; document.getElementById('gen').disabled = true }
document.getElementById('allow').onclick = () => { document.getElementById('install-ask').hidden = true; document.getElementById('installed').hidden = false; show('install') }
document.querySelectorAll('.copy').forEach(b => b.onclick = async () => { try { await navigator.clipboard.writeText(b.previousElementSibling.textContent); b.textContent = 'Copied' } catch { getSelection().selectAllChildren(b.previousElementSibling) } })
document.querySelectorAll('[data-view]')[0].classList.add('on')
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
  const m = fromManifest(url)
  res.end(page(m.name, m.scopes))
})
server.listen(0, '127.0.0.1', () => {
  const addr = server.address()
  console.log(typeof addr === 'object' && addr ? addr.port : 0)
})
