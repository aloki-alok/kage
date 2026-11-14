// Kage's Chrome extension (#114): polls the owner's own Kage hub for a command, runs it in this browser, and
// posts the result back. It answers only its own hub, on this machine, with the token from its options.
// The hub decides what a session may see (core/browser.ts); this side only reads.

const MAX_TEXT = 300_000   // the hub cuts further; this keeps one huge page from filling the post

const ops = {
  async tabs() {
    return (await chrome.tabs.query({})).map(t => ({ id: t.id, windowId: t.windowId, active: t.active, title: t.title ?? '', url: t.url ?? '' }))
  },
  async read({ tabId }) {
    const [r] = await chrome.scripting.executeScript({
      target: { tabId: Number(tabId) },
      func: () => ({ title: document.title, url: location.href, text: document.body ? document.body.innerText : '' }),
    })
    const p = r?.result
    if (!p) throw new Error('the page returned nothing')
    return { ...p, text: p.text.slice(0, MAX_TEXT) }
  },
  // Only the front tab of its window: capturing another would mean switching tabs under the owner.
  async screenshot({ tabId }) {
    const t = await chrome.tabs.get(Number(tabId))
    if (!t.active) throw new Error('that tab is not the front tab of its window, so it cannot be captured without switching to it')
    const png = await chrome.tabs.captureVisibleTab(t.windowId, { format: 'png' })
    // The owner may have switched tabs while it captured: the hub checks the block list on the tab really shown.
    const [shown] = await chrome.tabs.query({ active: true, windowId: t.windowId })
    if (shown?.id !== t.id) throw new Error('the owner switched tabs during the capture, so it was thrown away')
    return { url: shown.url ?? '', png }
  },
}

const settings = () => chrome.storage.local.get({ hub: 'http://127.0.0.1:8791', token: '' })

// What the popup shows, and a ! on the toolbar icon whenever Kage cannot reach this browser.
// connected | no-token | refused (wrong token) | unreachable (hub not running, or wrong address)
let last = ''
async function setState(state) {
  if (state === last && state !== 'connected') return
  last = state
  await chrome.storage.local.set({ status: { state, at: Date.now() } })
  await chrome.action.setBadgeText({ text: state === 'connected' ? '' : '!' })
  await chrome.action.setBadgeBackgroundColor({ color: '#c2410c' })
}

let polling = false
async function loop() {
  if (polling) return
  polling = true
  try {
    for (;;) {
      const { hub, token } = await settings()
      if (!token) { await setState('no-token'); return }
      const auth = { authorization: `Bearer ${token}` }
      let r
      try { r = await fetch(`${hub}/browser/next`, { headers: auth }) } catch { await setState('unreachable'); await sleep(5000); continue }
      if (r.status === 401) { await setState('refused'); return }
      // Only the hub answers 200 or 204 here: any other status is some other service on that port, or a wrong path.
      if (r.status !== 200 && r.status !== 204) { await setState('unreachable'); await sleep(5000); continue }
      await setState('connected')
      if (r.status === 204) continue
      const cmd = await r.json()
      let body
      try {
        if (!Object.hasOwn(ops, cmd.op)) throw new Error(`unknown command ${cmd.op}`)
        body = { id: cmd.id, ok: true, data: await ops[cmd.op](cmd.args ?? {}) }
      } catch (e) { body = { id: cmd.id, ok: false, error: String(e?.message ?? e) } }
      await fetch(`${hub}/browser/result`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify(body) }).catch(() => {})
    }
  } finally { polling = false }
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

// A service worker sleeps when idle; the alarm wakes it and restarts the loop if it died.
chrome.alarms.create('kage-poll', { periodInMinutes: 0.5 })
chrome.alarms.onAlarm.addListener(() => void loop())
chrome.runtime.onStartup.addListener(() => void loop())
chrome.runtime.onInstalled.addListener(() => void loop())
// New settings clear the shown state (options.js), so the next state is written even if it is the same as before.
chrome.storage.onChanged.addListener(c => { if (c.token || c.hub) { last = ''; void loop() } })
void loop()
