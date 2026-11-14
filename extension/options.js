const $ = id => document.getElementById(id)
const show = async () => {
  const s = await chrome.storage.local.get({ hub: 'http://127.0.0.1:8791', token: '', status: '' })
  $('hub').value = s.hub
  $('token').value = s.token
  $('status').textContent = s.token ? s.status || 'connecting' : 'not connected: paste the token'
}
$('save').onclick = async () => {
  await chrome.storage.local.set({ hub: $('hub').value.trim() || 'http://127.0.0.1:8791', token: $('token').value.trim(), status: '' })
  setTimeout(show, 1500)
}
chrome.storage.onChanged.addListener(show)
show()
