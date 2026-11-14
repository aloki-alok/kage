const $ = id => document.getElementById(id)
const DEFAULT_HUB = 'http://127.0.0.1:8791'

// Each state says what is wrong and the one thing that fixes it.
const STATES = {
  connected: ['Connected', at => `Last heard from your Kage at ${new Date(at).toLocaleTimeString()}.`],
  'no-token': ['Not connected', () => 'Run kage add browser in a terminal. It connects this browser by itself; if it does not, paste the token it printed.'],
  refused: ['Wrong token', () => 'Your Kage refused this token. Run kage add browser again and paste the new one.'],
  unreachable: ['Kage is not reachable', () => 'Start it with kage start, and check the hub address below.'],
}

async function show() {
  const s = await chrome.storage.local.get({ hub: DEFAULT_HUB, token: '', status: null })
  if (document.activeElement !== $('hub')) $('hub').value = s.hub
  if (document.activeElement !== $('token')) $('token').value = s.token
  const state = !s.token ? 'no-token' : s.status?.state ?? ''
  const [title, hint] = STATES[state] ?? ['Connecting…', () => '']
  $('state').dataset.state = state
  $('state-text').textContent = title
  $('state-hint').textContent = hint(s.status?.at ?? Date.now())
}

$('form').onsubmit = async e => {
  e.preventDefault()
  const token = $('token').value.trim()
  const hub = ($('hub').value.trim() || DEFAULT_HUB).replace(/\/+$/, '')
  let ok = true
  try { const u = new URL(hub); ok = u.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(u.hostname) } catch { ok = false }
  // The hub listens on this machine only, so any other address is a typo, or a page trying to collect the token.
  if (!ok) { $('error').textContent = 'The hub address must be on this machine: http://127.0.0.1:<port>'; return }
  if (!/^\S{24,}$/.test(token)) { $('error').textContent = 'Paste the token that kage add browser printed: 48 characters, no spaces.'; return }
  $('error').textContent = ''
  $('save').disabled = true
  await chrome.storage.local.set({ hub, token, status: null })
  $('save').disabled = false
}
chrome.storage.onChanged.addListener(show)
show()
