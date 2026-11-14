// Builds the docs site page from docs/concepts (titles in Departure Mono, served from fonts/ next to the page): one HTML file with every page, its diagram, search, keyboard nav,
// light and dark. Usage: node docs/site/build.mjs docs/concepts <out.html>. The gh-pages branch serves it at /docs/.
import { cpSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
const dir = process.argv[2], out = process.argv[3]
// docs/concepts/README.md is page 00 and its links set the order. A file it does not link still shows, after them.
const readme = readFileSync(join(dir, 'README.md'), 'utf8')
const files = readdirSync(dir).filter(f => f.endsWith('.md') && f !== 'README.md')
const linked = [...readme.matchAll(/\]\(([a-z0-9-]+)\.md\)/g)].map(m => m[1] + '.md').filter((f, i, a) => files.includes(f) && a.indexOf(f) === i)
const order = [...linked, ...files.filter(f => !linked.includes(f)).sort()]
const titleOf = md => md.match(/^# (.+)$/m)?.[1] ?? ''
const pages = [{ id: 'how-kage-works', file: 'README.md', title: titleOf(readme), md: readme },
  ...order.map(f => { const md = readFileSync(join(dir, f), 'utf8'); return { id: f.slice(0, -3), file: f, title: titleOf(md) || f, md } })]
const data = JSON.stringify({ pages }).replace(/</g, '\\u003c')

writeFileSync(out, `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Kage docs</title>
<meta name="description" content="How Kage works: one hub on your machine, a Claude Code session per conversation, and trust that comes from proof.">
<link rel="icon" href="../favicon.svg" type="image/svg+xml">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Instrument+Serif&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<style>
:root{--paper:#f2efe9;--panel:#e9e5dd;--ink:#16140f;--ink2:#47423a;--mid:#6d675e;--line:#d8d2c7;--line2:#e3ded5;--you:#ff4f00;--code:#ebe7df;
--serif:"Departure Mono","JetBrains Mono",monospace;--sans:"JetBrains Mono",ui-monospace,Menlo,monospace;--mono:"JetBrains Mono",ui-monospace,Menlo,monospace;--h1w:600;--h1s:.86;--ease:cubic-bezier(.19,1,.22,1)}
:root[data-theme="dark"]{--paper:#121110;--panel:#1b1916;--ink:#efe9df;--ink2:#cfc8bc;--mid:#a19b91;--line:#2c2925;--line2:#221f1c;--code:#1f1d1a}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--paper:#121110;--panel:#1b1916;--ink:#efe9df;--ink2:#cfc8bc;--mid:#a19b91;--line:#2c2925;--line2:#221f1c;--code:#1f1d1a}}
*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{margin:0;background:var(--paper);color:var(--ink);font:14.5px/1.8 var(--sans);-webkit-font-smoothing:antialiased}
a{color:inherit}
.mono{font-family:var(--mono)}
/* header */
@font-face{font-family:"Departure Mono";src:url("fonts/DepartureMono-Regular.woff2") format("woff2");font-display:swap}
header{position:sticky;top:0;z-index:5;background:color-mix(in srgb,var(--paper) 90%,transparent);backdrop-filter:blur(8px)}
.bar{display:grid;grid-template-columns:var(--rail) 1fr auto;align-items:center;height:64px;padding:0 36px;gap:0 56px;max-width:var(--page);margin:0 auto}
.logo{display:flex;align-items:baseline;gap:10px;text-decoration:none}
/* Kage's cast mark, as on the landing page: the word and its shadow */
.cast{position:relative;display:inline-block;line-height:1;white-space:nowrap;font:400 30px "Instrument Serif","Times New Roman",serif}
.cast .shadow{position:absolute;left:0;top:0;pointer-events:none;transform-origin:0 82%;transform:scaleY(-.55) skewX(-52deg);opacity:.35;-webkit-mask-image:linear-gradient(to bottom,transparent 5%,#000 90%);mask-image:linear-gradient(to bottom,transparent 5%,#000 90%)}
.logo .t{font:500 11px var(--mono);color:var(--mid);letter-spacing:.08em}
.keys{display:flex;gap:40px;font:500 12px var(--mono);letter-spacing:.06em}
.keys a{text-decoration:none;color:var(--ink2)}.keys a:hover{color:var(--ink)}
.keys a.on{color:var(--ink)}
.keys b{font-weight:400;color:var(--mid);margin-right:8px}
.tools{display:flex;gap:8px}
.btn{font:500 12px var(--mono);background:transparent;border:1px solid var(--line);color:var(--ink);padding:7px 12px;cursor:pointer;letter-spacing:.04em}
.btn:hover{border-color:var(--mid)}
.btn kbd{color:var(--mid);margin-left:10px;font:inherit}
/* the claude.dev post grid: a left rail, then one reading column that the title block shares */
:root{--rail:300px;--col:720px;--page:calc(var(--rail) + var(--col) + 128px)}
.grid{display:grid;grid-template-columns:var(--rail) minmax(0,var(--col));gap:0 56px;padding:0 36px;max-width:var(--page);margin:0 auto}
.hero{padding-top:72px;padding-bottom:56px}
.eyebrow{font:500 12px var(--mono);color:var(--mid);letter-spacing:.08em}
h1{font:400 clamp(30px,3.4vw,44px)/1.18 var(--serif);letter-spacing:-.01em;margin:16px 0 18px}
.stand{font-size:16px;line-height:1.75;color:var(--ink2);margin:0 0 34px;max-width:620px}
.meta{display:grid;grid-template-columns:repeat(3,minmax(0,200px));gap:0 24px;margin:0}
.meta dt{font:500 11px var(--mono);letter-spacing:.08em;color:var(--mid)}
.meta dd{margin:6px 0 0;font:13.5px var(--sans);color:var(--ink)}
.meta dd code{font-size:12.5px}
.rule{border:0;border-top:1px solid var(--line);margin:0}
main{padding:56px 0 120px;min-width:0}
nav.tree{position:sticky;top:64px;align-self:start;max-height:calc(100vh - 64px);overflow:auto;padding:56px 0 40px}
.tree .h{font:500 11px var(--mono);letter-spacing:.08em;color:var(--mid);margin-bottom:14px}
.tree a{display:grid;grid-template-columns:28px 1fr;text-decoration:none;color:var(--mid);font:12.5px/1.5 var(--mono);padding:5px 0}
.tree a .n{color:var(--line);color:color-mix(in srgb,var(--mid) 70%,transparent)}
.tree a:hover{color:var(--ink)}
.tree a.on{color:var(--ink)}
.tree a.on .n{color:var(--you)}
.tree .sub a{grid-template-columns:28px 14px 1fr;font-size:12px;padding:3px 0}
.tree .sub a::before{content:"";grid-column:2;width:7px;height:1px;background:var(--line);align-self:center}
.tree .sub a span{grid-column:3}
.tree .sub a.on{color:var(--ink)}
.prog{margin-top:24px;display:flex;align-items:center;gap:10px;font:500 11px var(--mono);color:var(--mid)}
.prog i{flex:1;height:2px;background:var(--line);position:relative}
.prog i::after{content:"";position:absolute;inset:0;width:var(--p,0%);background:var(--ink)}
figure{margin:0 0 44px;border:1px solid var(--line);background:var(--panel)}
figure .d{padding:28px 20px;overflow:auto;text-align:center;cursor:zoom-in}
figure .d svg{max-width:100%;height:auto}
figcaption{display:flex;justify-content:space-between;border-top:1px solid var(--line);padding:9px 14px;font:500 11px var(--mono);letter-spacing:.08em;color:var(--mid)}
.prose h2{font:400 22px/1.3 var(--serif);margin:48px 0 12px;scroll-margin-top:90px}
.prose h2 a.anchor{opacity:0;margin-left:10px;font:13px var(--mono);color:var(--mid);text-decoration:none}
.prose h2:hover a.anchor{opacity:1}
.prose p,.prose li{color:var(--ink2);max-width:68ch}
.prose p{margin:0 0 18px}
.prose a{text-decoration:underline;text-decoration-color:var(--line);text-underline-offset:4px;text-decoration-thickness:1px}
.prose a:hover{text-decoration-color:var(--ink)}
code{font:13px var(--mono);background:var(--code);padding:1px 5px}
pre{background:var(--code);padding:16px;overflow:auto}
pre code{background:none;padding:0}
/* pager */
.pager{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:72px}
.pager a{border:1px solid var(--line);padding:16px 18px;text-decoration:none;transition:border-color .25s var(--ease)}
.pager a:hover{border-color:var(--ink)}
.pager .k{font:500 11px var(--mono);letter-spacing:.08em;color:var(--mid)}
.pager .t{font:400 17px/1.3 var(--serif);margin-top:8px}
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
@media (max-width:980px){:root{--rail:0px}.grid{grid-template-columns:1fr;gap:0;padding:0 16px}nav.tree,.hero>.sp{display:none}.bar{grid-template-columns:1fr auto;padding:0 16px}.keys{display:none}.meta{grid-template-columns:1fr 1fr;gap:14px 24px}}
</style></head><body>
<header><div class="bar">
 <a class="logo" href="../"><span class="cast" aria-label="kage">kage<span class="shadow" aria-hidden="true">kage</span></span><span class="t">DOCS</span></a>
 <div class="keys"><a href="../"><b>[H]</b>HOME</a><a href="#how-kage-works" class="on"><b>[D]</b>DOCS</a><a href="https://github.com/aloki-alok/kage"><b>[G]</b>GITHUB</a></div>
 <div class="tools"><button class="btn" id="sbtn">Search<kbd>/</kbd></button><button class="btn" id="theme" title="Theme (T)">Theme</button></div>
</div></header>
<div class="grid hero"><div class="sp"></div><div id="hero"></div></div><hr class="rule"><div class="grid"><nav class="tree" id="tree"></nav><main id="main"></main></div>
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
let n=0,cur=0;
async function draw(){for(const el of document.querySelectorAll('pre.m')){const {svg}=await mermaid.render('m'+(n++),el.textContent);const f=document.createElement('figure');f.innerHTML='<div class="d">'+svg+'</div><figcaption><span>FIG. '+num(cur)+'</span><span>CLICK TO ENLARGE</span></figcaption>';f.querySelector('.d').onclick=()=>{$('#zoom').innerHTML=svg;$('#zoom').classList.add('open')};el.replaceWith(f)}}
function show(id){
 const i=Math.max(0,P.findIndex(p=>p.id===id));cur=i;const p=P[i];
 let md=p.md, fig='';
 md=md.replace(/^\`\`\`mermaid\\n([\\s\\S]*?)\`\`\`\\s*/,(_,c)=>{fig=c;return ''});
 const body=md.replace(/^# .+\\n+/,'');
 const first=(body.match(/^[^#\\n].+$/m)||[''])[0];
 const rest=body.replace(first,'');
 const words=plain(p.md).split(' ').length;
 const html=marked.parse(rest.replace(/\\]\\(([a-z-]+)\\.md\\)/g,'](#$1)').replace(/\\]\\(\\.\\.\\/settings\\.md\\)/g,'](https://github.com/aloki-alok/kage/blob/main/docs/settings.md)').replace(/\\]\\(\\.\\.\\/\\.\\.\\/AGENTS\\.md\\)/g,'](https://github.com/aloki-alok/kage/blob/main/AGENTS.md)'));
 $('#hero').innerHTML='<div class="fade"><div class="eyebrow">'+num(i)+' / '+(i?'CONCEPTS':'START HERE')+'</div><h1>'+esc(p.title)+'</h1><p class="stand">'+marked.parseInline(first)+'</p>'+
  '<dl class="meta"><div><dt>MODE</dt><dd>Explanation</dd></div><div><dt>READ</dt><dd>'+Math.max(1,Math.round(words/220))+' min</dd></div><div><dt>SOURCE</dt><dd><code>docs/concepts/'+p.file+'</code></dd></div></dl></div>';
 $('#main').innerHTML='<div class="fade">'+(fig?'<pre class="m">'+esc(fig)+'</pre>':'')+'<div class="prose">'+html+'</div>'+
  '<div class="pager">'+(i>0?'<a class="prev" href="#'+P[i-1].id+'"><div class="k">\u2190 PREVIOUS</div><div class="t">'+P[i-1].title+'</div></a>':'')+(i<P.length-1?'<a class="next" href="#'+P[i+1].id+'"><div class="k">NEXT \u2192</div><div class="t">'+P[i+1].title+'</div></a>':'')+'</div></div>';
 const hs=[...document.querySelectorAll('.prose h2')];hs.forEach(h=>{h.id=h.textContent.toLowerCase().replace(/[^a-z0-9]+/g,'-');h.insertAdjacentHTML('beforeend','<a class="anchor" href="#'+p.id+'/'+h.id+'">#</a>')});
 $('#tree').innerHTML='<div class="h">TREE</div>'+P.map((q,k)=>'<a href="#'+q.id+'" class="'+(k===i?'on':'')+'"><span class="n">'+num(k)+'</span><span>'+esc(q.title)+'</span></a>'+(k===i&&hs.length?'<div class="sub">'+hs.map(h=>'<a href="#'+p.id+'/'+h.id+'" data-h="'+h.id+'"><span>'+esc(h.childNodes[0].textContent)+'</span></a>').join('')+'</div>':'')).join('')+'<div class="prog"><i id="pbar"></i><span id="ptxt">00%</span></div>';
 initMermaid();draw();onScroll();
}
function route(){const [id,h]=location.hash.slice(1).split('/');if(id!==P[cur]?.id||!$('#main').innerHTML){show(id);scrollTo(0,0)}if(h){const el=document.getElementById(h);el&&el.scrollIntoView()}}
function onScroll(){const m=$('#main'),r=m.getBoundingClientRect(),t=Math.min(1,Math.max(0,(-r.top+64)/Math.max(1,r.height-innerHeight+64)));const b=$('#pbar');if(b){b.style.setProperty('--p',(t*100)+'%');$('#ptxt').textContent=String(Math.round(t*100)).padStart(2,'0')+'%'}
 let on=null;document.querySelectorAll('.prose h2').forEach(h=>{if(h.getBoundingClientRect().top<140)on=h.id});document.querySelectorAll('#tree a[data-h]').forEach(a=>a.classList.toggle('on',a.dataset.h===on))}
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
 else if(k==='h')location.href='../';else if(k==='d')location.hash=P[0].id;else if(k==='g')location.href='https://github.com/aloki-alok/kage';else if(k==='t')$('#theme').click();else if(k==='escape'){$('#zoom').classList.remove('open');closeS()}});
show(location.hash.slice(1).split('/')[0]||P[0].id);
</script></body></html>`)
cpSync(join(import.meta.dirname, 'fonts'), join(dirname(out), 'fonts'), { recursive: true })
console.log('wrote', out, pages.length, 'pages')
