const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

type Line = { text: string; needs?: boolean; id?: string }

const STYLE = `
@font-face { font-family: "Geist Pixel Square"; src: url("/type.woff2") format("woff2"); font-display: swap; }
:root { --bg: #0a0b0d; --ink: #e4e6e8; --muted: #7d838b; --faint: #464b52; --line: #1c1f23; --signal: #ff4f00; --sop: .5;
  --display: "Geist Pixel Square", "JetBrains Mono", ui-monospace, monospace; --mono: "JetBrains Mono", ui-monospace, Menlo, monospace; color-scheme: dark; }
@media (prefers-color-scheme: light) { :root { --bg: #f2efe9; --ink: #16140f; --muted: #6d675e; --faint: #b3aca1; --line: #ddd7cd; --sop: .4; color-scheme: light; } }
html { overflow-x: clip; } * { box-sizing: border-box; }
body { margin: 0; min-height: 100dvh; display: grid; grid-template-rows: auto 1fr auto; grid-template-columns: minmax(0, 1fr); background: var(--bg); color: var(--ink); font: 400 15px/1.6 var(--mono); }
.wrap { width: 100%; max-width: 1100px; margin: 0 auto; padding-inline: 20px; }
header .wrap, footer .wrap { display: flex; justify-content: space-between; align-items: center; gap: 16px; padding-block: 28px; }
footer .wrap { border-top: 1px solid var(--line); font-size: 12px; color: var(--muted); flex-wrap: wrap; }
a { color: var(--ink); text-underline-offset: 3px; text-decoration-color: var(--faint); }
:focus-visible { outline: 2px solid var(--signal); outline-offset: 3px; }
.cast { position: relative; display: inline-block; line-height: 1; white-space: nowrap; }
.cast .shadow { position: absolute; left: 0; top: 0; pointer-events: none; transform-origin: 0 82%;
  transform: scaleY(calc(-1 * var(--len, .6))) skewX(calc(-1 * var(--skew, 48deg))); opacity: var(--sop);
  -webkit-mask-image: linear-gradient(to bottom, transparent 5%, #000 90%); mask-image: linear-gradient(to bottom, transparent 5%, #000 90%); }
.mark { font: 400 2rem var(--display); --len: .55; --skew: 52deg; }
.mark .shadow { opacity: .35; }
.where { font: 400 12px/1 var(--mono); color: var(--muted); letter-spacing: .04em; }
main { align-self: center; padding-block: 32px 72px; }
.say { font: 400 var(--fs, 104px)/1 var(--display); letter-spacing: -.02em; margin: 18px 0 0; position: relative; }
.say::after { content: ""; position: absolute; left: 0; right: 0; bottom: .19em; height: 1px; background: var(--ink); opacity: .14; }
.say input { font: inherit; letter-spacing: inherit; color: inherit; background: none; border: 0; padding: 0; margin: 0; width: 8ch; caret-color: var(--signal); }
.say .measure { position: absolute; visibility: hidden; white-space: pre; left: 0; top: 0; }
.say input:focus { outline: none; }
.say label { cursor: text; }
.work { list-style: none; margin: clamp(56px, 9vw, 104px) 0 0 auto; padding: 0; max-width: 66ch; font: 400 14px/1.75 var(--mono); overflow-wrap: anywhere; }
.work li { padding-left: 6ch; text-indent: -6ch; }
.work li::before { content: "kage  "; color: var(--faint); white-space: pre; }
.work li + li::before { content: "      "; }
.work .needs { color: var(--signal); }
.cta { display: flex; gap: 18px; align-items: center; justify-content: flex-end; margin-top: 28px; flex-wrap: wrap; }
.btn { font: 600 12px/1 var(--mono); letter-spacing: .08em; text-transform: uppercase; color: var(--bg); background: var(--ink); padding: 14px 18px; text-decoration: none; border: 0; cursor: pointer; }
.btn:hover { opacity: .88; }
.btn:disabled { opacity: .35; cursor: not-allowed; }
@media (max-width: 640px) { .work { margin-left: 0; } .cta { justify-content: flex-start; } }
`

const FIT = `
const say = document.querySelector('.say'), main = document.querySelector('main .wrap')
function fit() { say.style.setProperty('--fs', '104px'); size(); const room = main.clientWidth - 40, need = say.firstElementChild.scrollWidth; if (need > room) say.style.setProperty('--fs', Math.max(20, Math.floor(104 * room / need)) + 'px'); size() }
function size() { const m = document.getElementById('m'), n = document.getElementById('n'); if (m && n) { m.textContent = n.value || ' '; n.style.width = m.offsetWidth + 'px' } }
addEventListener('resize', fit); document.fonts.ready.then(fit); fit()
`

function frame(o: { title: string; say: string; shadow: string; lines: Line[]; cta?: string; script?: string; foot: string }): string {
  const lines = o.lines.map(l => `<li${l.id ? ` id="${l.id}"` : ''}${l.needs ? ' class="needs"' : ''}>${esc(l.text)}</li>`).join('')
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(o.title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600&display=swap">
<style>${STYLE}</style></head><body>
<header><div class="wrap"><span class="cast mark" aria-label="kage">kage<span class="shadow" aria-hidden="true">kage</span></span><span class="where">GitHub setup, on this machine</span></div></header>
<main><div class="wrap"><p class="say"><span class="cast">${o.say}<span class="shadow" id="sh" aria-hidden="true">${esc(o.shadow)}</span></span></p>
<ul class="work" aria-live="polite">${lines}</ul>${o.cta ?? ''}</div></main>
<footer><div class="wrap"><span>kage connect github</span><span>${esc(o.foot)}</span></div></footer>
<script>${FIT}${o.script ?? ''}</script></body></html>`
}

const ASK = ' look at this'

export function namePage(o: { name: string; account: string; problem?: string }): string {
  const lines: Line[] = [
    { text: `The app lives on ${o.account}. Only a tag of it wakes me.` },
    o.problem ? { text: o.problem, needs: true, id: 'check' } : { text: `Pick the name people type after @. Short names are often a person's account already.`, id: 'check' },
  ]
  return frame({
    title: 'Name Kage on GitHub', shadow: `@${o.name}${ASK}`, foot: 'This page runs on your machine and closes when you are done.',
    say: `<span class="measure" id="m" aria-hidden="true"></span><label for="n">@</label><input id="n" form="f" name="name" value="${esc(o.name)}" aria-label="The name people tag" autocomplete="off" spellcheck="false" maxlength="35" autofocus>${esc(ASK)}`,
    lines,
    cta: '<form id="f" class="cta" method="get" action="/go"><button class="btn" id="go">Create on GitHub</button></form>',
    script: `
const n = document.getElementById('n'), sh = document.getElementById('sh'), out = document.getElementById('check'), go = document.getElementById('go')
let wait, asked = 0
function paint() { sh.textContent = '@' + n.value + ${JSON.stringify(ASK)}; fit() }
async function check() {
  const mine = ++asked
  go.disabled = true
  out.className = ''; out.textContent = 'Checking @' + n.value.trim().replace(/^@/, '') + ' on GitHub.'
  const r = await fetch('/name?n=' + encodeURIComponent(n.value)).then(x => x.json()).catch(() => ({ ok: true, say: 'Kage could not check the name. GitHub says so on the next page if it is taken.' }))
  if (mine !== asked) return
  out.textContent = r.say; out.className = r.ok ? '' : 'needs'; go.disabled = !r.ok
}
n.addEventListener('input', () => { paint(); clearTimeout(wait); wait = setTimeout(check, 350) })
paint(); check()
`,
  })
}

export function goPage(o: { name: string; action: string; manifest: string }): string {
  return frame({
    title: 'Kage on GitHub', say: `@${esc(o.name)}`, shadow: `@${o.name}`, foot: 'This page runs on your machine and closes when you are done.',
    lines: [{ text: 'Taking you to GitHub.' }, { text: 'Click Create GitHub App there, and I take it from here.', needs: true }],
    cta: `<form id="f" class="cta" method="post" action="${esc(o.action)}"><input type="hidden" name="manifest" value="${esc(o.manifest)}"><button class="btn">Continue to GitHub</button></form>`,
    script: `document.getElementById('f').submit()`,
  })
}

export function donePage(o: { slug: string; url: string; hook: string; account: string }): string {
  return frame({
    title: `@${o.slug} is ready`, say: `@${esc(o.slug)}${esc(ASK)}`, shadow: `@${o.slug}${ASK}`, foot: 'You can close this tab once the app is installed.',
    lines: [
      { text: `Made @${o.slug} on ${o.account}.` },
      { text: 'Kept its private key on this machine.' },
      { text: `Listening at ${o.hook}.` },
      { text: 'Install it on the repos where people should tag it.', needs: true },
    ],
    cta: `<div class="cta"><a class="btn" href="${esc(`${o.url}/installations/new`)}">Install on GitHub</a></div>`,
  })
}

export function failPage(o: { title: string; why: string }): string {
  return frame({
    title: o.title, say: esc(o.title), shadow: o.title, foot: 'This page runs on your machine.',
    lines: [{ text: o.why, needs: true }, { text: 'Run kage connect github again in your terminal.' }],
  })
}
