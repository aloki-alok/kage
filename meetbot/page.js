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
    // "Switch here" and "Join here too": Meet still holds a seat for this account (a bot that did not leave).
    join: [['button', /^ask to join$/i], ['button', /^join now$/i], ['button', /^join$/i], ['button', /^switch here$/i], ['button', /^join here too$/i]],
    noticeJoin: [['[role="dialog"] button, [role="alertdialog"] button', /^join now$/i]],   // "someone else takes notes" notice
    // Any popup over the lobby, whatever Meet adds next: let the mic in first (Kage speaks), else close it. Never "without".
    blocker: [['button', /^allow microphone/i], ['[role="dialog"] button, [role="alertdialog"] button', /^(got it|dismiss|close|ok|not now|no thanks)$/i]],
    captionsOn: [['button', /turn on captions/i]],
    chatOpen: [['button', /chat with everyone|^chat$/i]],
    chatBox: [['textarea, [contenteditable="true"]', /send a message/i]],
    leave: [['button', /leave call/i]],
    micOn: [['button', /turn on microphone/i]],
    camOn: [['button', /turn on camera/i]],
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
  if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia = async constraints => {
    // No real camera or mic, ever: the mic is Kage's own voice, and the camera is the drawn tile below.
    if (ctx.state !== 'running') await ctx.resume().catch(() => {})
    const tracks = []
    if (constraints?.audio) tracks.push(out.stream.getAudioTracks()[0].clone())
    if (constraints?.video) tracks.push(tile().getVideoTracks()[0].clone())
    return new MediaStream(tracks)
  }
  // Kage's tile: its avatar beside a panel with what it heard, what it is doing, and its voice as bars.
  // The avatar comes from the bot (face()); the status from the voice bridge (status()). Drawn on a timer,
  // since a headless tab may never paint frames.
  const level = ctx.createAnalyser()
  level.fftSize = 256
  ctx.createMediaStreamSource(out.stream).connect(level)
  let tileStream, img, said = 'listening', heard = ''
  const face = url => { const i = new Image(); i.onload = () => { img = i }; i.src = url }
  const status = (what, line) => { said = what; if (line !== undefined) heard = line }
  function wrap(g, text, x, y, w, lh, max) {
    const words = text.split(' '), lines = []
    let cur = ''
    for (const wd of words) { const t = cur ? cur + ' ' + wd : wd; if (g.measureText(t).width > w && cur) { lines.push(cur); cur = wd } else cur = t }
    if (cur) lines.push(cur)
    lines.slice(-max).forEach((l, i) => g.fillText(l, x, y + i * lh))
  }
  function tile() {
    if (tileStream) return tileStream
    const c = document.createElement('canvas')
    c.width = 1280; c.height = 720
    const g = c.getContext('2d'), bins = new Uint8Array(level.frequencyBinCount)
    let loud = 0
    const draw = t => {
      level.getByteFrequencyData(bins)
      let sum = 0
      for (const v of bins) sum += v
      loud = Math.max(sum / bins.length / 90, loud * 0.88)
      const W = c.width, H = c.height
      g.fillStyle = '#0a0a0a'; g.fillRect(0, 0, W, H)
      if (img) {
        g.drawImage(img, 0, 0, H, H)
        g.fillStyle = `rgba(200, 16, 16, ${Math.min(0.35, loud * 0.4)})`; g.fillRect(0, 0, H, H)
        // The avatar's gold star, twinkling: brighter while Kage talks.
        const sx = H * 0.86, sy = H * 0.17, r = 26 + 10 * Math.sin(t / 300) + loud * 40
        const glow = g.createRadialGradient(sx, sy, 0, sx, sy, r)
        glow.addColorStop(0, 'rgba(255, 220, 120, 0.9)'); glow.addColorStop(1, 'rgba(255, 200, 80, 0)')
        g.fillStyle = glow; g.beginPath(); g.arc(sx, sy, r, 0, Math.PI * 2); g.fill()
      }
      const x = H + 56, w = W - x - 56
      g.fillStyle = '#c81010'; g.fillRect(H, 0, 8, H)
      g.fillStyle = '#f2efe8'; g.font = '800 104px "Arial Black", Impact, sans-serif'; g.textBaseline = 'top'
      g.fillText('KAGE', x, 64)
      g.fillStyle = '#c81010'; g.font = '700 34px ui-monospace, Menlo, monospace'
      g.fillText(`● ${said}`, x, 200)
      g.fillStyle = '#9c978d'; g.font = '400 30px ui-sans-serif, system-ui'
      if (heard) wrap(g, `“${heard}”`, x, 262, w, 40, 4)
      const n = 40, bw = w / n
      for (let i = 0; i < n; i++) {
        const v = bins[Math.floor(i * bins.length / n / 2)] / 255
        const h = 6 + v * 180 + (said === 'listening' ? 4 * Math.sin(t / 400 + i / 3) : 0)
        g.fillStyle = i % 7 === 3 ? '#c81010' : '#f2efe8'
        g.fillRect(x + i * bw, H - 70 - h, bw * 0.6, h)
      }
    }
    setInterval(() => draw(performance.now()), 66)
    return (tileStream = c.captureStream(15))
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

  // The text of a popup still in the way, so a failed join says what blocked it.
  const dialog = () => [...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')].filter(visible).map(d => d.innerText.replace(/\s+/g, ' ').trim().slice(0, 200)).join(' | ')
  // 4. A voice pipeline as ears and mouth (meetbot/voice-agent.ts). listen() taps every call audio track Meet plays
  //    and hands 16 kHz PCM16 chunks to window.kageAudio. Meet never plays Kage its own voice, so there is no echo.
  //    play() queues the pipeline's 16 kHz PCM16 into Kage's mic in order, and clear() drops it when someone cuts in.
  let tapped
  function listen() {
    if (tapped) return
    tapped = new Set()
    const ac = new AudioContext({ sampleRate: 16000 })
    const proc = ac.createScriptProcessor(2048, 1, 1)
    const mute = ac.createGain()
    mute.gain.value = 0
    proc.connect(mute).connect(ac.destination)
    proc.onaudioprocess = e => {
      const f = e.inputBuffer.getChannelData(0), pcm = new Int16Array(f.length)
      for (let i = 0; i < f.length; i++) pcm[i] = Math.max(-1, Math.min(1, f[i])) * 0x7fff
      let s = ''
      for (const b of new Uint8Array(pcm.buffer)) s += String.fromCharCode(b)
      window.kageAudio?.(btoa(s))
    }
    const scanAudio = () => {
      for (const el of document.querySelectorAll('audio, video')) {
        for (const t of el.srcObject?.getAudioTracks?.() ?? []) {
          if (tapped.has(t.id)) continue
          tapped.add(t.id)
          ac.createMediaStreamSource(new MediaStream([t])).connect(proc)
        }
      }
    }
    scanAudio()
    setInterval(scanAudio, 1000)
    ac.resume().catch(() => {})
  }
  let next = 0
  const queued = new Set()
  function play(b64) {
    if (ctx.state !== 'running') ctx.resume().catch(() => {})
    const b = atob(b64), n = b.length >> 1, buf = ctx.createBuffer(1, n, 16000), ch = buf.getChannelData(0)
    for (let i = 0; i < n; i++) { const v = b.charCodeAt(2 * i) | (b.charCodeAt(2 * i + 1) << 8); ch[i] = (v > 32767 ? v - 65536 : v) / 32768 }
    const src = ctx.createBufferSource()
    src.buffer = buf
    src.connect(out)
    next = Math.max(next, ctx.currentTime + 0.05)
    src.start(next)
    next += buf.duration
    queued.add(src)
    src.onended = () => queued.delete(src)
  }
  function clear() { for (const s of queued) try { s.stop() } catch {} ; queued.clear(); next = 0 }
  const buttons = () => [...document.querySelectorAll('button')].filter(visible).map(label).filter(Boolean).slice(0, 15).join(', ')
  const captionsShown = () => !!document.querySelector(SEL.captions)
  window.__kage = { say, hush, settled, scan, mark, state, others, dialog, buttons, captionsShown, face, status, listen, play, clear }
})()
