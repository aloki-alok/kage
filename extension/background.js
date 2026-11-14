// Kage's Chrome extension (#114): polls the owner's own Kage hub for a command, runs it in this browser, and
// posts the result back. It answers only its own hub, on this machine, with the token from its options.
// The hub decides what a session may see and do (core/browser.ts, core/browser-act.ts). Every action that changes a
// page reaches this side only after the owner's yes on the hub's approval card.

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
  async snapshot({ tabId }) {
    return ready(await inPage(tabId, 'snapshot'))
  },
  // What a ref is right now, and what has focus, for the approval card: the hub names the control from this.
  async describe({ tabId, ref }) {
    return ready(await inPage(tabId, 'describe', [ref]))
  },
  // expect: the site and control the owner approved. page.js checks them, the view and the hit point in one go.
  async click({ tabId, ref, expect }) {
    const at = ready(await inPage(tabId, 'prepare', [ref, false, expect]))
    const base = { x: at.x, y: at.y, button: 'left', clickCount: 1 }
    await cdp(tabId, [['Input.dispatchMouseEvent', { ...base, type: 'mouseMoved' }], ['Input.dispatchMouseEvent', { ...base, type: 'mousePressed' }], ['Input.dispatchMouseEvent', { ...base, type: 'mouseReleased' }]])
    return { url: at.url }
  },
  async type({ tabId, ref, text, expect }) {
    const at = ready(await inPage(tabId, 'prepare', [ref, true, expect]))
    await cdp(tabId, [['Input.insertText', { text: String(text) }]])
    return { url: at.url }
  },
  async press({ tabId, key, expect }) {
    const code = KEYCODES[key]
    if (!code) throw new Error(`unknown key ${key}`)
    const at = ready(await inPage(tabId, 'keyTarget', [expect]))
    const k = { key, code: key, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code, ...(key === 'Enter' && { text: '\r' }) }
    await cdp(tabId, [['Input.dispatchKeyEvent', { ...k, type: 'keyDown' }], ['Input.dispatchKeyEvent', { ...k, type: 'keyUp' }]])
    return { url: at.url }
  },
  async navigate({ tabId, url }) {
    await chrome.tabs.update(Number(tabId), { url })
    return { url }
  },
  async open({ url }) {
    const tab = await chrome.tabs.create({ url, active: false })
    await intoKageGroup(tab)
    return { tabId: tab.id, url }
  },
}

const run = async (tabId, func, args = []) => (await chrome.scripting.executeScript({ target: { tabId: Number(tabId) }, func, args }))[0]?.result
// page.js in the page's isolated world, then one call into it. Its refs live there, out of the page's reach.
async function inPage(tabId, method, args = []) {
  await chrome.scripting.executeScript({ target: { tabId: Number(tabId) }, files: ['page.js'] })
  return run(tabId, (m, a) => globalThis.__kage[m](...a), [method, args])
}
const ready = at => { if (!at) throw new Error('the page returned nothing'); if (at.refused) throw new Error(at.refused); return at }

// Real input through the Chrome DevTools Protocol, so a page sees a trusted click or keystroke, as from a person.
// Attached for one action only: Chrome shows its "is debugging this browser" bar meanwhile, which is the point.
async function cdp(tabId, steps) {
  const target = { tabId: Number(tabId) }
  await chrome.debugger.attach(target, '1.3')
  try { for (const [method, params] of steps) await chrome.debugger.sendCommand(target, method, params) }
  finally { await chrome.debugger.detach(target).catch(() => {}) }
}

const KEYCODES = { Enter: 13, Tab: 9, Escape: 27, Backspace: 8, ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, PageUp: 33, PageDown: 34 }

// Kage's own tabs sit in one group named Kage, so the owner sees at a glance what it opened.
async function intoKageGroup(tab) {
  const [g] = await chrome.tabGroups.query({ title: 'Kage', windowId: tab.windowId })
  const groupId = await chrome.tabs.group({ tabIds: [tab.id], ...(g && { groupId: g.id }) })
  if (!g) await chrome.tabGroups.update(groupId, { title: 'Kage', color: 'grey' })
}

const settings = () => chrome.storage.local.get({ hub: 'http://127.0.0.1:8791', token: '' })

// kage add browser registers a helper only this extension may start (core/browser-pair.ts). It answers with the
// token from the settings file, so a new token needs no paste. Returns true when it gave a different token.
const HOST = 'dev.kage.pair'
// At most one ask per 5 minutes: the alarm restarts the loop every 30 s, and each ask starts a process. Kept in
// session storage, since Chrome restarts an idle service worker and that would reset a variable.
async function pair() {
  const { asked = 0 } = await chrome.storage.session.get('asked')
  if (Date.now() - asked < 300_000) return false
  await chrome.storage.session.set({ asked: Date.now() })
  let r
  try { r = await chrome.runtime.sendNativeMessage(HOST, { want: 'token' }) } catch { return false }   // no helper: paste by hand
  if (!r?.token || !r.hub) return false
  const { token } = await settings()
  if (r.token === token) return false
  last = ''
  await chrome.storage.local.set({ token: r.token, hub: r.hub, status: null })
  return true
}

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
      if (!token) { if (await pair()) continue; await setState('no-token'); return }
      const auth = { authorization: `Bearer ${token}` }
      let r
      try { r = await fetch(`${hub}/browser/next`, { headers: auth }) } catch { await setState('unreachable'); await sleep(5000); continue }
      // A refused token may be an old one: kage add browser made a new one since. Ask the helper once.
      if (r.status === 401) { if (await pair()) continue; await setState('refused'); return }
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
