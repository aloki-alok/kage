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

let polling = false
async function loop() {
  if (polling) return
  polling = true
  try {
    for (;;) {
      const { hub, token } = await settings()
      if (!token) return
      const auth = { authorization: `Bearer ${token}` }
      let r
      try { r = await fetch(`${hub}/browser/next`, { headers: auth }) } catch { await sleep(5000); continue }
      if (r.status === 401) { await chrome.storage.local.set({ status: 'the hub refused the token' }); return }
      await chrome.storage.local.set({ status: `connected ${new Date().toLocaleTimeString()}` })
      if (r.status !== 200) { if (r.status !== 204) await sleep(5000); continue }
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
chrome.storage.onChanged.addListener(c => { if (c.token || c.hub) void loop() })
void loop()
