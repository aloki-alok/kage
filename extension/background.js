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
  async click({ tabId, ref, expect }, gone) {
    void driving()
    const at = ready(await inPage(tabId, 'prepare', [ref, false, expect]))
    tooLate(gone)
    // Press and release only, right after the hit test: a mouse move first would give the page's mousemove
    // handlers a turn to lay something over the control between the check and the click.
    const base = { x: at.x, y: at.y, button: 'left', clickCount: 1 }
    await cdp(tabId, [['Input.dispatchMouseEvent', { ...base, type: 'mousePressed' }], ['Input.dispatchMouseEvent', { ...base, type: 'mouseReleased' }]])
    return { url: at.url }
  },
  async type({ tabId, ref, text, expect }, gone) {
    void driving()
    const at = ready(await inPage(tabId, 'prepare', [ref, true, expect]))
    tooLate(gone)
    await cdp(tabId, [['Input.insertText', { text: String(text) }]])
    return { url: at.url }
  },
  async press({ tabId, key, expect }, gone) {
    void driving()
    const code = KEYCODES[key]
    if (!code) throw new Error(`unknown key ${key}`)
    const at = ready(await inPage(tabId, 'keyTarget', [expect]))
    tooLate(gone)
    const k = { key, code: key, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code, ...(key === 'Enter' && { text: '\r' }) }
    await cdp(tabId, [['Input.dispatchKeyEvent', { ...k, type: 'keyDown' }], ['Input.dispatchKeyEvent', { ...k, type: 'keyUp' }]])
    return { url: at.url }
  },
  // A picture of one control as the owner's screen shows it, for the approval card: CSS can draw text the DOM
  // does not hold, so the picture is what the owner checks. Only for the front tab of its window.
  async crop({ tabId, ref }) {
    const t = await chrome.tabs.get(Number(tabId))
    if (!t.active) throw new Error('that tab is not the front tab of its window')
    const b = ready(await inPage(tabId, 'box', [ref]))
    const shot = await (await fetch(await chrome.tabs.captureVisibleTab(t.windowId, { format: 'png' }))).blob()
    const img = await createImageBitmap(shot)
    const pad = 12, k = b.dpr || 1
    const sx = Math.max(0, (b.x - pad) * k), sy = Math.max(0, (b.y - pad) * k)
    const sw = Math.min(img.width - sx, (b.w + 2 * pad) * k), sh = Math.min(img.height - sy, (b.h + 2 * pad) * k)
    if (sw < 1 || sh < 1) throw new Error('the control is outside the visible part of the tab')
    const canvas = new OffscreenCanvas(sw, sh)
    canvas.getContext('2d').drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh)
    const bytes = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer())
    let bin = ''
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
    return { url: b.url, png: `data:image/png;base64,${btoa(bin)}` }
  },
  async version() { return chrome.runtime.getManifest().version },
  async navigate({ tabId, url }) {
    await chrome.tabs.update(Number(tabId), { url })
    return { url }
  },
  // In front, in the owner's last used window, in the Kage group: Chrome can picture and act only in a front tab.
  async open({ url }) {
    const w = await chrome.windows.getLastFocused({ windowTypes: ['normal'] })
    const tab = await chrome.tabs.create({ url, windowId: w.id, active: true })
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
  // With no window named, Chrome makes the group in the window in front and moves the tab there.
  const groupId = await chrome.tabs.group({ tabIds: [tab.id], ...(g ? { groupId: g.id } : { createProperties: { windowId: tab.windowId } }) })
  if (!g) await chrome.tabGroups.update(groupId, { title: 'Kage', color: 'grey' })
}

const settings = () => chrome.storage.local.get({ hub: 'http://127.0.0.1:8791', token: '' })

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
let last = '', drivingUntil = 0
async function setState(state) {
  if (state === last && state !== 'connected') return
  last = state
  await chrome.storage.local.set({ status: { state, at: Date.now() } })
  if (Date.now() < drivingUntil) return
  await chrome.action.setBadgeText({ text: state === 'connected' ? '' : '!' })
  await chrome.action.setBadgeBackgroundColor({ color: '#c2410c' })
}
// While Kage acts, the toolbar badge turns blue, so the owner sees it from any tab.
async function driving() {
  drivingUntil = Date.now() + 5000
  await chrome.action.setBadgeText({ text: '•' })
  await chrome.action.setBadgeBackgroundColor({ color: '#2563eb' })
  setTimeout(() => { if (Date.now() >= drivingUntil) { const s = last; last = ''; void setState(s) } }, 5100)
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
      try { r = await fetch(`${hub}/browser/next`, { headers: { ...auth, 'x-kage-extension': chrome.runtime.getManifest().version } }) } catch { await setState('unreachable'); await sleep(5000); continue }
      if (r.status === 401) { if (await pair()) continue; await setState('refused'); return }
      // Only the hub answers 200 or 204 here: any other status is some other service on that port, or a wrong path.
      if (r.status !== 200 && r.status !== 204) { await setState('unreachable'); await sleep(5000); continue }
      await setState('connected')
      if (r.status === 204) continue
      const cmd = await r.json()
      let body
      try {
        if (!Object.hasOwn(ops, cmd.op)) throw new Error(`unknown command ${cmd.op}`)
        body = { id: cmd.id, ok: true, data: await withDeadline(gone => ops[cmd.op](cmd.args ?? {}, gone), cmd.ms) }
      } catch (e) { body = { id: cmd.id, ok: false, error: String(e?.message ?? e) } }
      await fetch(`${hub}/browser/result`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify(body) }).catch(() => {})
    }
  } finally { polling = false }
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
// A command stuck in a page (an open dialog, a long script) must not hold the loop, or no poll follows and the alarm
// cannot restart a loop that still runs (#528). Past the hub's own wait it fails, and the loop takes the next one.
// The stuck command still runs on: gone() tells an action it is too late, so a retry and it never both land.
function withDeadline(work, ms) {
  let late = false, timer
  const running = work(() => late)
  if (!(ms > 0)) return running   // an older hub sends no ms
  const deadline = new Promise((_, no) => { timer = setTimeout(() => { late = true; no(new Error(`it did not finish in ${Math.round(ms / 1000)} s`)) }, ms) })
  return Promise.race([running, deadline]).finally(() => clearTimeout(timer))
}
const tooLate = gone => { if (gone()) throw new Error('the hub gave up on this action, so it was not done') }
// A service worker sleeps when idle; the alarm wakes it and restarts the loop if it died.
chrome.alarms.create('kage-poll', { periodInMinutes: 0.5 })
chrome.alarms.onAlarm.addListener(() => { void loop(); void reloadIfChanged() })
// An unpacked extension runs the code it loaded, not what a git pull put on disk since. A new version in
// manifest.json on disk reloads it, so an update needs no click in chrome://extensions.
async function reloadIfChanged() {
  const disk = await fetch(chrome.runtime.getURL('manifest.json'), { cache: 'no-store' }).then(r => r.json()).catch(() => undefined)
  if (disk?.version && disk.version !== chrome.runtime.getManifest().version) chrome.runtime.reload()
}
chrome.runtime.onStartup.addListener(() => void loop())
chrome.runtime.onInstalled.addListener(() => void loop())
// New settings clear the shown state (options.js), so the next state is written even if it is the same as before.
chrome.storage.onChanged.addListener(c => { if (c.token || c.hub) { last = ''; void loop() } })
void loop()
