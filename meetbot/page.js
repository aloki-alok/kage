// Runs inside the Meet tab before Meet's own code (an init script). Three jobs:
// 1. The microphone: getUserMedia hands Meet an audio track Kage controls, so speech plays into the call.
// 2. The ears: Meet's live captions, read from the page. A caption block keeps growing while its speaker talks
//    and Meet revises recent words, so a line goes out only once its text has held still for SETTLE_MS.
// 3. Everything Kage knows about Meet's page, in one place, so a Meet redesign is fixed here and nowhere else.
//    mark() tags the control to use with data-kage, and bot.ts clicks or types there with real input events.
(() => {
  if (window.__kage) return
  const SETTLE_MS = 1200

  // Meet's captions and controls. Meet's class names change often, so roles and labels come first.
  const SEL = {
    captions: '[role="region"][aria-label*="aption" i]',
    speaker: '.NWpY1d, .KcIKyf, .zs7s8d',
    text: '.ygicle, .VbkSUe, .iTTPOb',
  }
  // Controls by what they say, not by class: [selector, words in the label or text, in order of preference].
  const CONTROLS = {
    name: [['input[type="text"]', /your name/i]],
    join: [['button', /^ask to join$/i], ['button', /^join now$/i], ['button', /^join$/i]],
    noticeJoin: [['[role="dialog"] button, [role="alertdialog"] button', /^join now$/i]],   // "someone else takes notes" notice
    captionsOn: [['button', /turn on captions/i]],
    chatOpen: [['button', /chat with everyone|^chat$/i]],
    chatBox: [['textarea, [contenteditable="true"]', /send a message/i]],
    leave: [['button', /leave call/i]],
  }
  const label = el => `${el.getAttribute('aria-label') ?? ''} ${el.getAttribute('placeholder') ?? ''} ${el.innerText ?? ''}`.replace(/\s+/g, ' ').trim()
  const visible = el => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length)
  function mark(kind) {
    for (const old of document.querySelectorAll(`[data-kage="${kind}"]`)) old.removeAttribute('data-kage')
    for (const [sel, words] of CONTROLS[kind]) {
      const el = [...document.querySelectorAll(sel)].find(e => visible(e) && (words.test(label(e)) || words.test(e.getAttribute('aria-label') ?? '')))
      if (el) { el.setAttribute('data-kage', kind); return true }
    }
    return false
  }
  // Where the bot stands. The words are Meet's screens; refused and ended win over the rest, since old text lingers.
  function state() {
    const body = document.body?.innerText ?? ''
    if (/check your meeting code|can.t join this (video )?call|denied your request|weren.t allowed to join|no one responded to your request/i.test(body)) return 'refused'
    if (/you left the meeting|you.ve been removed|the call has ended|meeting has ended|call ended/i.test(body)) return 'ended'
    if ([...document.querySelectorAll('[data-participant-id]')].some(visible) || mark('leave')) return 'in'
    if (/asking to be let in|when someone lets you in|waiting for the host/i.test(body)) return 'waiting'
    return 'lobby'
  }
  // How many people are in the call besides Kage, from the participant tiles. -1 when Meet shows none.
  const others = () => {
    const ids = new Set([...document.querySelectorAll('[data-participant-id]')].filter(visible).map(e => e.getAttribute('data-participant-id')))
    return ids.size ? ids.size - 1 : -1
  }

  // 1. The microphone. One AudioContext for the call; say() plays a clip into it.
  const ctx = new AudioContext({ sampleRate: 48000 })
  const out = ctx.createMediaStreamDestination()
  const realGUM = navigator.mediaDevices?.getUserMedia?.bind(navigator.mediaDevices)
  if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia = async constraints => {
    if (!constraints?.audio) return realGUM(constraints)
    if (ctx.state !== 'running') await ctx.resume().catch(() => {})
    const stream = new MediaStream([out.stream.getAudioTracks()[0].clone()])
    if (constraints.video && realGUM) {
      try { for (const t of (await realGUM({ video: constraints.video })).getVideoTracks()) stream.addTrack(t) } catch {}
    }
    return stream
  }
  let playing
  async function say(b64) {
    if (ctx.state !== 'running') await ctx.resume().catch(() => {})
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0))
    const buf = await ctx.decodeAudioData(bytes.buffer)
    playing?.stop()
    const src = ctx.createBufferSource()
    src.buffer = buf
    src.connect(out)
    playing = src
    await new Promise(done => { src.onended = done; src.start() })
    if (playing === src) playing = undefined
    return buf.duration
  }
  const hush = () => { playing?.stop(); playing = undefined }

  // 2. The ears. Each caption block is tracked by its element: its speaker, its text, what was sent.
  const blocks = new Map()   // element -> { speaker, text, at, sent }
  const textOf = el => (el?.innerText ?? el?.textContent ?? '').replace(/\s+/g, ' ').trim()
  function scan() {
    const region = document.querySelector(SEL.captions)
    if (!region) return
    for (const t of region.querySelectorAll(SEL.text)) {
      // The speaker's name sits beside the text in the same block, a level or two up.
      let speaker = 'Someone'
      for (let el = t.parentElement, i = 0; el && el !== region && i < 4; el = el.parentElement, i++) {
        const s = el.querySelector(SEL.speaker)
        if (s) { speaker = textOf(s) || speaker; break }
      }
      const text = textOf(t)
      const b = blocks.get(t)
      if (!b) blocks.set(t, { speaker, text, at: Date.now(), sent: '' })
      else if (b.text !== text) { b.text = text; b.speaker = speaker; b.at = Date.now() }
    }
  }
  // Lines whose text held still: the new part only, or the whole line if Meet rewrote what was sent.
  function settled() {
    const lines = []
    for (const [el, b] of blocks) {
      if (Date.now() - b.at >= SETTLE_MS && b.text && b.text !== b.sent) {
        const fresh = b.sent && b.text.startsWith(b.sent) ? b.text.slice(b.sent.length).trim() : b.text
        if (fresh) lines.push({ speaker: b.speaker, text: fresh })
        b.sent = b.text
      }
      if (!el.isConnected && b.text === b.sent) blocks.delete(el)
    }
    return lines
  }
  new MutationObserver(scan).observe(document, { subtree: true, childList: true, characterData: true })

  window.__kage = { say, hush, settled, scan, mark, state, others }
})()
