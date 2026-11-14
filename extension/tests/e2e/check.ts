// End-to-end check of Kage's Chrome extension against page.html, through the real hub bridge (connectors/browser.ts).
// run.py starts Chromium with the extension, paired by kage add browser; this side drives it and checks each rule.
// Exits 1 on the first rule that does not hold.
import { connectBrowser } from '../../../connectors/browser.ts'
import { elementsResult, type Snapshot } from '../../../core/browser-act.ts'
import type { Page, Tab } from '../../../core/browser.ts'

const b = connectBrowser({ token: process.env.KAGE_E2E_TOKEN!, port: Number(process.env.KAGE_E2E_PORT), callMs: 30_000 })
await b.listening
const until = Date.now() + 30_000
while (!b.connected()) { if (Date.now() > until) { console.error('the extension never connected'); process.exit(1) } await new Promise(r => setTimeout(r, 200)) }
let failed = 0
const check = (what: string, ok: boolean, got = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${ok ? '' : `: ${got}`}`); if (!ok) failed++ }

const t = (await b.call('tabs', {}) as Tab[]).find(x => x.url.includes('page.html'))!
const snap = await b.call('snapshot', { tabId: t.id }) as Snapshot
const list = elementsResult(snap, [])
const el = (name: string) => snap.elements.find(e => e.name === name || e.name.startsWith(`${name} (`))!
const out = async () => (await b.call('read', { tabId: t.id }) as Page).text.split('\n')[0]!
const act = async (op: string, args: Record<string, unknown>) => { try { await b.call(op, { tabId: t.id, ...args }); return 'done' } catch (e) { return `refused: ${(e as Error).message}` } }
const click = (name: string) => { const e = el(name); return act('click', { ref: e.ref, expect: { host: '127.0.0.1', role: e.role, name: e.name } }) }

check('a password shows only that it is filled', /textbox "Secret" = "\(filled\)"/.test(list), list)
check('card number, one-time code and token-named fields are masked', ['Card', 'Code', 'Key'].every(n => el(n)?.value === '(filled)'), list)
check('invisible, offscreen and clipped fields are not listed', !/tok-|Offscreen|Clipped/.test(list), list)
check('a ref the page presets is ignored', el('Send').ref !== 1 || snap.elements.filter(e => e.ref === 1).length === 1, list)
check('aria-label beside different visible text shows both', /"Delete account \(labelled \\"Cancel\\"\)"/.test(list), list)
check('text drawn by CSS is flagged', snap.elements.some(e => e.name.includes('styled text')), list)
check('a link names the site it opens', /link "Unsubscribe" -> evil\.example/.test(list), list)
check('text drawn by CSS inside a child is flagged', snap.elements.filter(e => e.name.includes('styled text')).length >= 2, list)
check('values hidden in a zero box, drawn transparent or under a cover are not shown', !/tok-/.test(list), list)

const name = el('Name'), search = el('Search')
await act('type', { ref: name.ref, text: 'Ryu', expect: { host: '127.0.0.1', role: name.role, name: name.name } })
await click('Say hello')
check('typing and a click reach the page as trusted input', (await out()) === 'Hello Ryu (trusted)', await out())
await act('type', { ref: search.ref, text: 'kage', expect: { host: '127.0.0.1', role: search.role, name: search.name } })
await act('press', { key: 'Enter', expect: { host: '127.0.0.1', role: search.role, name: search.name } })
check('Enter in a field submits its form', (await b.call('read', { tabId: t.id }) as Page).text.includes('submitted'))
check('a click on the real Send, not the forged ref', (await click('Send')) === 'done' && (await out()) === 'send clicked', await out())
check('a yes for "Cancel" does not click "Delete account"', (await act('click', { ref: el('Delete account').ref, expect: { host: '127.0.0.1', role: 'button', name: 'Cancel' } })).startsWith('refused'))
check('a covered control is refused', (await click('Covered')).startsWith('refused') && (await out()) !== 'OVERLAY got it', await out())
check('a mousemove trap cannot catch the click', (await click('Mover')) === 'done' && (await out()) === 'mover clicked', await out())
check('a control far down a smooth-scrolling page is clicked', (await click('Far')).startsWith('refused') === false, await out())
check('a site change between yes and act is refused', (await act('click', { ref: el('Send').ref, expect: { host: 'other.example', role: 'button', name: 'Send' } })).startsWith('refused'))
const crop = await b.call('crop', { tabId: t.id, ref: el('Send').ref }) as { png: string }
check('a crop of the control comes back as a PNG', crop.png.startsWith('data:image/png;base64,iVBOR'), crop.png.slice(0, 40))

b.close()
console.log(failed ? `${failed} failed` : 'all passed')
process.exit(failed ? 1 : 0)
