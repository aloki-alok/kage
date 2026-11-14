// Builds the docs site page from docs/concepts: one HTML file with every page, its diagram, search, keyboard nav,
// light and dark. Usage: node docs/site/build.mjs docs/concepts <out.html>. The gh-pages branch serves it at /docs/.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const dir = process.argv[2], out = process.argv[3]
const order = ['slack-threads-and-sessions', 'who-may-drive-kage', 'approvals', 'kagelets', 'memory-and-skills',
  'afk-mode', 'kage-in-chrome', 'email', 'whatsapp', 'voice-and-calls', 'settings-and-tokens', 'updates-and-releases']
const groups = { 'slack-threads-and-sessions': 'Core', 'kagelets': 'Work it does', 'afk-mode': 'Surfaces', 'settings-and-tokens': 'Running it' }
const have = new Set(readdirSync(dir))

const arch = `flowchart TD
  IN["Slack, WhatsApp, email, calls, Chrome, GitHub"]:::door
  IN --> CN["Connectors turn each message into one task"]
  CN --> GT["Gate: who sent it, how much trust"]
  GT -->|no proof| X["Dropped. Nothing runs."]
  GT --> DS["Dispatcher: one session per conversation"]
  SC["Schedules and kagelets"] --> DS
  DS --> SE["Claude Code session, in a sandbox"]
  SE --> TL["Kage tools"]
  TL -->|risky call| AP["Approval card in your DM"]:::you
  TL --> OB["Outbound guard: no secrets, no crowd pings"]
  OB --> BACK["Answer in the same thread"]:::door
  CF["config.json and secrets.json"]:::key -.->|hub only| CN`
const archMd = '```mermaid\n' + arch + '\n```\n\n# How Kage works\n\nEvery message, from any surface, enters one process on your machine: the hub. The hub decides who sent it and how far they may go, gives each conversation its own Claude Code session, and checks everything that leaves.\n\n## One hub, many doors\n\nSlack, WhatsApp, email, phone calls, your Chrome and GitHub all arrive at the same place. A connector turns each one into the same task shape, so the rest of Kage never cares where a message came from.\n\n## Trust comes from proof\n\nThe gate reads who sent a message and what proves it. Your own typed words get owner trust. A listed teammate gets teammate trust. A message with no proof is dropped before Claude ever reads it. [Who may drive Kage](#who-may-drive-kage) has the full table.\n\n## One session per conversation\n\nEach Slack thread, email thread or call keeps its own Claude Code session, and a restart resumes it. [Slack threads and sessions](#slack-threads-and-sessions) explains the keys.\n\n## Risky calls wait for you\n\nA session works with Kage\'s tools. A call that acts as you, such as posting somewhere new or clicking in your browser, waits for your yes on a card in your DM. [Approvals](#approvals) covers the card.\n\n## Nothing secret leaves\n\nTokens live in `secrets.json`, and only the hub reads them. Every session runs in a sandbox that cannot open that file. Every outgoing message passes one guard that blocks secrets and crowd pings. [Settings and tokens](#settings-and-tokens) explains the split.'

const pages = [{ id: 'how-kage-works', title: 'How Kage works', group: 'Start here', md: archMd }]
for (const id of order) {
  if (!have.has(id + '.md')) continue
  const md = readFileSync(join(dir, id + '.md'), 'utf8')
  pages.push({ id, title: md.match(/^# (.+)$/m)?.[1] ?? id, group: groups[id] ?? pages.at(-1).group, md })
}
const data = JSON.stringify({ pages }).replace(/</g, '\\u003c')

writeFileSync(out, `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Kage docs</title>
<meta name="description" content="How Kage works: one hub on your machine, a Claude Code session per conversation, and trust that comes from proof.">
<link rel="icon" href="../favicon.svg" type="image/svg+xml">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Familjen+Grotesk:wght@500;600&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<style>
:root{--paper:#f2efe9;--panel:#e9e5dd;--ink:#16140f;--ink2:#47423a;--mid:#6d675e;--line:#d8d2c7;--line2:#e3ded5;--you:#ff4f00;--code:#ebe7df;
--serif:"Familjen Grotesk",system-ui,sans-serif;--sans:"JetBrains Mono",ui-monospace,Menlo,monospace;--mono:"JetBrains Mono",ui-monospace,Menlo,monospace;--h1w:600;--h1s:.86;--ease:cubic-bezier(.19,1,.22,1)}
:root[data-theme="dark"]{--paper:#121110;--panel:#1b1916;--ink:#efe9df;--ink2:#cfc8bc;--mid:#a19b91;--line:#2c2925;--line2:#221f1c;--code:#1f1d1a}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--paper:#121110;--panel:#1b1916;--ink:#efe9df;--ink2:#cfc8bc;--mid:#a19b91;--line:#2c2925;--line2:#221f1c;--code:#1f1d1a}}
*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{margin:0;background:var(--paper);color:var(--ink);font:14.5px/1.8 var(--sans);-webkit-font-smoothing:antialiased}
a{color:inherit}
.mono{font-family:var(--mono)}
/* header */
header{position:sticky;top:0;z-index:5;background:color-mix(in srgb,var(--paper) 88%,transparent);backdrop-filter:blur(8px);border-bottom:1px solid var(--line)}
.bar{display:grid;grid-template-columns:280px 1fr auto;align-items:center;height:60px;padding:0 28px;gap:20px}
.logo{display:flex;align-items:baseline;gap:10px;text-decoration:none}
.logo .w{font:400 30px/1 var(--serif);position:relative}
.logo .t{font:500 11px var(--mono);color:var(--mid);letter-spacing:.06em}
.keys{display:flex;gap:26px;font:500 12px var(--mono);color:var(--mid);letter-spacing:.04em}
.keys a{text-decoration:none}.keys a:hover{color:var(--ink)}
.keys b{font-weight:500;color:var(--mid);opacity:.7;margin-right:6px}
.tools{display:flex;gap:8px}
.btn{font:500 12px var(--mono);background:transparent;border:1px solid var(--line);color:var(--ink);padding:7px 12px;cursor:pointer;letter-spacing:.03em}
.btn:hover{border-color:var(--mid)}
.btn kbd{color:var(--mid);margin-left:10px;font:inherit}
/* layout */
.page{display:grid;grid-template-columns:280px minmax(0,1fr) 240px;gap:0 48px;padding:0 28px;max-width:1440px;margin:0 auto}
nav.side{position:sticky;top:60px;align-self:start;height:calc(100vh - 60px);overflow:auto;padding:32px 0 40px}
.grp{font:500 11px var(--mono);letter-spacing:.08em;color:var(--mid);margin:26px 0 8px;text-transform:uppercase}
.grp:first-child{margin-top:0}
nav.side a{display:grid;grid-template-columns:30px 1fr;padding:6px 10px 6px 0;text-decoration:none;color:var(--ink2);font-size:13px;border-left:1px solid var(--line);padding-left:14px;transition:color .2s var(--ease),border-color .2s var(--ease)}
nav.side a .n{font:500 11px/2 var(--mono);color:var(--mid)}
nav.side a:hover{color:var(--ink)}
nav.side a.on{color:var(--ink);border-left:2px solid var(--ink);padding-left:13px;font-weight:500}
main{padding:56px 0 120px;min-width:0}
.col{max-width:700px}
.eyebrow{font:500 12px var(--mono);color:var(--mid);letter-spacing:.06em}
h1{font:var(--h1w) calc(clamp(44px,5.4vw,68px)*var(--h1s))/1.02 var(--serif);letter-spacing:-.015em;margin:14px 0 18px}
.stand{font-size:16.5px;line-height:1.7;color:var(--ink2);margin:0 0 30px;max-width:620px}
.meta{display:grid;grid-template-columns:repeat(3,auto);justify-content:start;gap:0 56px;padding:0 0 30px;border-bottom:1px solid var(--line);margin-bottom:34px}
.meta dt{font:500 11px var(--mono);letter-spacing:.08em;color:var(--mid)}
.meta dd{margin:4px 0 0;font:14px var(--sans)}
.meta dd code{font-size:12.5px}
figure{margin:0 0 40px;border:1px solid var(--line);background:var(--panel)}
figure .d{padding:28px 20px;overflow:auto;text-align:center;cursor:zoom-in}
figure .d svg{max-width:100%;height:auto}
figcaption{display:flex;justify-content:space-between;border-top:1px solid var(--line);padding:9px 14px;font:500 11px var(--mono);letter-spacing:.06em;color:var(--mid)}
.prose h2{font:var(--h1w) calc(30px*var(--h1s))/1.15 var(--serif);margin:46px 0 12px;scroll-margin-top:84px}
.prose h2 a.anchor{opacity:0;margin-left:8px;font:13px var(--mono);color:var(--mid);text-decoration:none}
.prose h2:hover a.anchor{opacity:1}
.prose p,.prose li{color:var(--ink2);max-width:66ch}
.prose p{margin:0 0 16px}
.prose a{text-decoration:underline;text-decoration-color:var(--line);text-underline-offset:4px;text-decoration-thickness:1px}
.prose a:hover{text-decoration-color:var(--ink)}
code{font:13.5px var(--mono);background:var(--code);padding:1px 5px}
pre{background:var(--code);padding:16px;overflow:auto}
pre code{background:none;padding:0}
.you{border-left:2px solid var(--you);padding:12px 16px;background:color-mix(in srgb,var(--you) 6%,transparent);margin:26px 0;font-size:15px}
.you b{font:600 11px var(--mono);letter-spacing:.08em;color:var(--you);display:block;margin-bottom:4px}
/* outline */
aside.toc{position:sticky;top:60px;align-self:start;padding:56px 0 40px}
.toc .h{font:500 11px var(--mono);letter-spacing:.08em;color:var(--mid);margin-bottom:12px}
.toc a{display:block;font:12px/1.5 var(--sans);color:var(--mid);text-decoration:none;padding:5px 0 5px 12px;border-left:1px solid var(--line)}
.toc a.on{color:var(--ink);border-left-color:var(--ink)}
.prog{margin-top:22px;display:flex;align-items:center;gap:10px;font:500 11px var(--mono);color:var(--mid)}
.prog i{flex:1;height:2px;background:var(--line);position:relative}
.prog i::after{content:"";position:absolute;inset:0;width:var(--p,0%);background:var(--ink)}
/* pager */
.pager{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:64px;max-width:700px}
.pager a{border:1px solid var(--line);padding:16px 18px;text-decoration:none;transition:border-color .25s var(--ease),transform .25s var(--ease)}
.pager a:hover{border-color:var(--ink);transform:translateY(-1px)}
.pager .k{font:500 11px var(--mono);letter-spacing:.06em;color:var(--mid)}
.pager .t{font:var(--h1w) 22px/1.2 var(--serif);margin-top:6px}
.pager .next{text-align:right;grid-column:2}
/* search */
.scrim{position:fixed;inset:0;background:color-mix(in srgb,var(--ink) 30%,transparent);display:none;z-index:20;padding-top:12vh}
.scrim.open{display:block}
.palette{max-width:620px;margin:0 auto;background:var(--paper);border:1px solid var(--line);box-shadow:0 30px 80px -30px rgba(0,0,0,.4)}
.palette input{width:100%;border:0;border-bottom:1px solid var(--line);background:transparent;padding:18px 20px;font:16px var(--sans);color:var(--ink);outline:none}
.res{max-height:50vh;overflow:auto}
.res a{display:block;padding:12px 20px;text-decoration:none;border-bottom:1px solid var(--line2)}
.res a.sel,.res a:hover{background:var(--panel)}
.res .rt{font-weight:500}.res .rs{font-size:13px;color:var(--mid);margin-top:2px}
.res mark{background:color-mix(in srgb,var(--you) 22%,transparent);color:inherit}
.res .empty{padding:18px 20px;color:var(--mid);font-size:14px}
.zoom{position:fixed;inset:0;background:var(--paper);z-index:30;display:none;overflow:auto;padding:40px;cursor:zoom-out}
.zoom.open{display:block}.zoom svg{width:100%;height:auto;max-height:none}
.fade{animation:in .5s var(--ease) both}@keyframes in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
@media (max-width:1180px){.page{grid-template-columns:240px minmax(0,1fr)}aside.toc{display:none}.bar{grid-template-columns:240px 1fr auto}}
@media (max-width:820px){.page{grid-template-columns:1fr;padding:0 16px}nav.side{display:none}.bar{grid-template-columns:1fr auto;padding:0 16px}.keys{display:none}.meta{grid-template-columns:1fr 1fr;gap:14px 24px}h1{font-size:44px}}
</style></head><body>
<header><div class="bar">
 <a class="logo" href="#how-kage-works"><span class="w">kage</span><span class="t">DOCS</span></a>
 <div class="keys"><a href="#how-kage-works"><b>[H]</b>HOW IT WORKS</a><a href="#" id="kprev"><b>[J]</b>PREV</a><a href="#" id="knext"><b>[K]</b>NEXT</a><a href="https://github.com/aloki-alok/kage/tree/main/docs/concepts"><b>[G]</b>GITHUB</a></div>
 <div class="tools"><button class="btn" id="sbtn">Search<kbd>/</kbd></button><button class="btn" id="theme" title="Theme (T)">Theme</button></div>
</div></header>
<div class="page"><nav class="side" id="side"></nav><main id="main"></main><aside class="toc" id="toc"></aside></div>
<div class="scrim" id="scrim"><div class="palette"><input id="q" placeholder="Search the docs" autocomplete="off"><div class="res" id="res"></div></div></div>
<div class="zoom" id="zoom"></div>
<script src="https://cdn.jsdelivr.net/npm/marked@12.0.2/marked.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/mermaid@10.9.1/dist/mermaid.min.js"></script>
<script>
const D=${data};
const P=D.pages, $=s=>document.querySelector(s);
const esc=s=>s.replace(/&/g,'&amp;').replace(/</g,'&lt;');
const plain=md=>md.replace(/\`\`\`[\\s\\S]*?\`\`\`/g,'').replace(/^#.*$/gm,'').replace(/\\[([^\\]]+)\\]\\([^)]+\\)/g,'$1').replace(/[\`*]/g,'').replace(/\\s+/g,' ').trim();
const num=i=>String(i).padStart(2,'0');
function dark(){const t=document.documentElement.dataset.theme;return t?t==='dark':matchMedia('(prefers-color-scheme: dark)').matches}
function initMermaid(){const d=dark();mermaid.initialize({startOnLoad:false,theme:'base',securityLevel:'strict',fontFamily:'JetBrains Mono, monospace',
 flowchart:{useMaxWidth:false,nodeSpacing:36,rankSpacing:44,curve:'basis'},
 themeVariables:{fontSize:'13px',background:'transparent',primaryColor:d?'#1f1d1a':'#f7f5f0',primaryTextColor:d?'#efe9df':'#16140f',primaryBorderColor:d?'#4a453e':'#b9b2a6',lineColor:d?'#8a847a':'#8a847a',
 clusterBkg:'transparent',edgeLabelBackground:d?'#1b1916':'#e9e5dd',actorBkg:d?'#1f1d1a':'#f7f5f0',actorBorder:d?'#4a453e':'#b9b2a6',actorTextColor:d?'#efe9df':'#16140f',signalColor:'#8a847a',signalTextColor:d?'#efe9df':'#16140f',labelBoxBkgColor:d?'#1f1d1a':'#f7f5f0',noteBkgColor:d?'#1f1d1a':'#f7f5f0'},
 themeCSS:'.door>rect,.door>polygon{stroke:'+(d?'#efe9df':'#16140f')+'!important;stroke-width:1.5px!important} .you>rect{stroke:#ff4f00!important;stroke-width:1.5px!important} .key>rect{stroke-dasharray:4 3!important;opacity:.8} .node rect{rx:0;ry:0}'})}
// sidebar
let g='';$('#side').innerHTML=P.map((p,i)=>{let h='';if(p.group!==g){g=p.group;h='<div class="grp">'+g+'</div>'}return h+'<a href="#'+p.id+'" data-id="'+p.id+'"><span class="n">'+num(i)+'</span><span>'+p.title+'</span></a>'}).join('');
let n=0,cur=0;
async function draw(){for(const el of document.querySelectorAll('pre.m')){const {svg}=await mermaid.render('m'+(n++),el.textContent);const f=document.createElement('figure');f.innerHTML='<div class="d">'+svg+'</div><figcaption><span>FIG. '+num(cur)+'</span><span>CLICK TO ENLARGE</span></figcaption>';f.querySelector('.d').onclick=()=>{$('#zoom').innerHTML=svg;$('#zoom').classList.add('open')};el.replaceWith(f)}}
function show(id){
 const i=Math.max(0,P.findIndex(p=>p.id===id));cur=i;const p=P[i];
 document.querySelectorAll('#side a').forEach(a=>a.classList.toggle('on',a.dataset.id===p.id));
 let md=p.md, fig='';
 md=md.replace(/^\`\`\`mermaid\\n([\\s\\S]*?)\`\`\`\\s*/,(_,c)=>{fig=c;return ''});
 const body=md.replace(/^# .+\\n+/,'');
 const first=(body.match(/^[^#\\n].+$/m)||[''])[0];
 const rest=body.replace(first,'');
 const words=plain(p.md).split(' ').length;
 const html=marked.parse(rest.replace(/\\]\\(([a-z-]+)\\.md\\)/g,'](#$1)').replace(/\\]\\(\\.\\.\\/settings\\.md\\)/g,'](https://github.com/aloki-alok/kage/blob/main/docs/settings.md)').replace(/\\]\\(\\.\\.\\/\\.\\.\\/AGENTS\\.md\\)/g,'](https://github.com/aloki-alok/kage/blob/main/AGENTS.md)'));
 $('#main').innerHTML='<div class="col fade"><div class="eyebrow">'+num(i)+' / '+(p.group||'').toUpperCase()+'</div><h1>'+esc(p.title)+'</h1><p class="stand">'+marked.parseInline(first)+'</p>'+
  '<dl class="meta"><div><dt>MODE</dt><dd>Explanation</dd></div><div><dt>READ</dt><dd>'+Math.max(1,Math.round(words/220))+' min</dd></div><div><dt>SOURCE</dt><dd><code>docs/concepts/'+(i?p.id+'.md':'README.md')+'</code></dd></div></dl>'+
  (fig?'<pre class="m">'+esc(fig)+'</pre>':'')+'<div class="prose">'+html+'</div>'+
  '<div class="pager">'+(i>0?'<a class="prev" href="#'+P[i-1].id+'"><div class="k">PREVIOUS</div><div class="t">'+P[i-1].title+'</div></a>':'')+(i<P.length-1?'<a class="next" href="#'+P[i+1].id+'"><div class="k">NEXT</div><div class="t">'+P[i+1].title+'</div></a>':'')+'</div></div>';
 // anchors and outline
 const hs=[...document.querySelectorAll('.prose h2')];hs.forEach(h=>{h.id=h.textContent.toLowerCase().replace(/[^a-z0-9]+/g,'-');h.insertAdjacentHTML('beforeend','<a class="anchor" href="#'+p.id+'/'+h.id+'">#</a>')});
 $('#toc').innerHTML='<div class="h">ON THIS PAGE</div>'+(hs.length?hs.map(h=>'<a href="#'+p.id+'/'+h.id+'" data-h="'+h.id+'">'+esc(h.childNodes[0].textContent)+'</a>').join(''):'<a class="on">'+esc(p.title)+'</a>')+'<div class="prog"><i id="pbar"></i><span id="ptxt">0%</span></div>';
 $('#kprev').href='#'+P[Math.max(0,i-1)].id;$('#knext').href='#'+P[Math.min(P.length-1,i+1)].id;
 initMermaid();draw();onScroll();
}
function route(){const [id,h]=location.hash.slice(1).split('/');if(id!==P[cur]?.id||!$('#main').innerHTML){show(id);scrollTo(0,0)}if(h){const el=document.getElementById(h);el&&el.scrollIntoView()}}
function onScroll(){const m=$('#main'),r=m.getBoundingClientRect(),t=Math.min(1,Math.max(0,(-r.top+60)/(r.height-innerHeight+60)));const b=$('#pbar');if(b){b.style.setProperty('--p',(t*100)+'%');$('#ptxt').textContent=Math.round(t*100)+'%'}
 let on=null;document.querySelectorAll('.prose h2').forEach(h=>{if(h.getBoundingClientRect().top<140)on=h.id});document.querySelectorAll('#toc a[data-h]').forEach(a=>a.classList.toggle('on',a.dataset.h===on))}
addEventListener('scroll',onScroll,{passive:true});addEventListener('hashchange',route);
// theme
$('#theme').onclick=()=>{const r=document.documentElement;r.dataset.theme=dark()?'light':'dark';try{localStorage.setItem('kage-docs-theme',r.dataset.theme)}catch(e){}show(location.hash.slice(1).split('/')[0]||P[0].id)};
try{const t=localStorage.getItem('kage-docs-theme');if(t)document.documentElement.dataset.theme=t}catch(e){}
// search
const idx=P.map((p,i)=>({i,p,text:plain(p.md)}));let sel=0;
function search(q){q=q.trim().toLowerCase();const r=q?idx.filter(x=>(x.p.title+' '+x.text).toLowerCase().includes(q)).slice(0,8):idx.slice(0,8);sel=0;
 $('#res').innerHTML=r.length?r.map((x,k)=>{const at=x.text.toLowerCase().indexOf(q);const sn=q&&at>=0?esc(x.text.slice(Math.max(0,at-50),at))+'<mark>'+esc(x.text.slice(at,at+q.length))+'</mark>'+esc(x.text.slice(at+q.length,at+q.length+70)):esc(x.text.slice(0,110));return '<a href="#'+x.p.id+'" class="'+(k?'':'sel')+'"><div class="rt"><span class="mono" style="color:var(--mid);font-size:12px;margin-right:10px">'+num(x.i)+'</span>'+x.p.title+'</div><div class="rs">'+sn+'</div></a>'}).join(''):'<div class="empty">No page mentions that.</div>'}
function openS(){$('#scrim').classList.add('open');$('#q').value='';search('');$('#q').focus()}
function closeS(){$('#scrim').classList.remove('open')}
$('#sbtn').onclick=openS;$('#scrim').onclick=e=>{if(e.target.id==='scrim')closeS()};$('#res').onclick=closeS;
$('#q').oninput=e=>search(e.target.value);
$('#q').onkeydown=e=>{const a=[...document.querySelectorAll('#res a')];if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();a[sel]?.classList.remove('sel');sel=(sel+(e.key==='ArrowDown'?1:a.length-1))%a.length;a[sel]?.classList.add('sel');a[sel]?.scrollIntoView({block:'nearest'})}if(e.key==='Enter'&&a[sel]){location.hash=a[sel].getAttribute('href');closeS()}if(e.key==='Escape')closeS()};
$('#zoom').onclick=()=>$('#zoom').classList.remove('open');
addEventListener('keydown',e=>{if(e.target.tagName==='INPUT')return;if(e.metaKey||e.ctrlKey)return;const k=e.key.toLowerCase();
 if(k==='/'){e.preventDefault();openS()}else if(k==='j')location.hash=P[Math.max(0,cur-1)].id;else if(k==='k')location.hash=P[Math.min(P.length-1,cur+1)].id;
 else if(k==='h')location.hash=P[0].id;else if(k==='t')$('#theme').click();else if(k==='escape'){$('#zoom').classList.remove('open');closeS()}});
show(location.hash.slice(1).split('/')[0]||P[0].id);
</script></body></html>`)
console.log('wrote', out, pages.length, 'pages')
