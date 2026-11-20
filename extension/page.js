// Injected into a page's isolated world (chrome.scripting, files: ['page.js']), where the page's own scripts cannot
// reach. Refs live here, in a Map the page cannot see or forge, not in DOM attributes a page could copy or preset.
// Defined once per page; later injections reuse it, so a ref stays bound to its element while the page lives.
globalThis.__kage ??= (() => {
  const byRef = new Map()        // ref -> WeakRef(element)
  const refOf = new WeakMap()    // element -> ref
  let next = 1
  const CORE = 'a[href], button, input, select, textarea, summary, [role=button], [role=link], [role=checkbox], [role=radio], [role=tab], [role=menuitem], [role=option], [role=switch], [role=combobox], [role=textbox], [role=searchbox], [contenteditable=""], [contenteditable=true]'
  // Rows and items that act like buttons (an inbox list), and anything a keyboard can focus.
  const SEL = `${CORE}, [role=row], [role=gridcell], [role=listitem], [role=treeitem], [role=menuitemradio], [role=menuitemcheckbox], [tabindex="0"]`
  const pointer = el => getComputedStyle(el).cursor === 'pointer'
  const TAG_ROLE = { A: 'link', BUTTON: 'button', SELECT: 'combobox', TEXTAREA: 'textbox', SUMMARY: 'button' }
  const INPUT_ROLE = { checkbox: 'checkbox', radio: 'radio', submit: 'button', button: 'button', reset: 'button', image: 'button', range: 'slider', search: 'searchbox' }
  // Values Kage never sees: passwords, card details, one-time codes, and fields named like tokens.
  const SECRET_AUTOCOMPLETE = /(^|\s)(cc-|one-time-code|current-password|new-password)/
  const SECRET_NAME = /otp|token|csrf|secret|cvc|cvv|card.?num|ssn|\bpin\b|passw/i

  const clean = s => (s ?? '').replace(/\s+/g, ' ').trim()
  // What the owner sees while Kage acts: a ring where it clicks or types, and a pill in the corner. Styles go
  // through the CSSOM, which a page's CSP allows, in a closed shadow root the page's CSS cannot reach. Clicks
  // pass through it (pointer-events: none), so elementFromPoint in prepare still sees only the page.
  let mark, hideAt = 0
  const showMark = (x, y) => {
    if (!mark?.host.isConnected) {
      const host = document.createElement('kage-mark')
      host.style.cssText = 'all: initial; position: fixed; inset: 0; z-index: 2147483647; pointer-events: none; display: block'
      const root = host.attachShadow({ mode: 'closed' })
      const ring = document.createElement('div'), pill = document.createElement('div')
      ring.style.cssText = 'position: fixed; width: 28px; height: 28px; margin: -17px 0 0 -17px; border: 3px solid #2563eb; border-radius: 50%; box-shadow: 0 0 0 4px rgba(37, 99, 235, .25); transition: left .15s, top .15s'
      pill.style.cssText = 'position: fixed; right: 16px; bottom: 16px; padding: 6px 12px; border-radius: 999px; background: #111827; color: #fff; font: 500 12px/1.4 system-ui, sans-serif'
      pill.textContent = 'Kage is using this tab'
      root.append(ring, pill)
      document.documentElement.append(host)
      mark = { host, ring }
    }
    mark.host.style.display = 'block'
    mark.ring.style.display = x === undefined ? 'none' : 'block'
    if (x !== undefined) { mark.ring.style.left = `${x}px`; mark.ring.style.top = `${y}px` }
    hideAt = Date.now() + 5000
    setTimeout(() => { if (Date.now() >= hideAt && mark) mark.host.style.display = 'none' }, 5100)
  }
  const refFor = el => {
    let ref = refOf.get(el)
    if (!ref) { ref = next++; refOf.set(el, ref); byRef.set(ref, new WeakRef(el)) }
    return ref
  }
  // The box whose overflow can clip el: a fixed or absolute element skips the ancestors it escapes. Meta's
  // dashboard draws its whole app in fixed boxes under a zero-height wrapper, so a plain parent walk hid it all.
  // Every box that holds fixed children must be here, or a value under it leaks: a missed one is skipped, not checked.
  const holdsFixed = st => [st.transform, st.translate, st.rotate, st.scale, st.perspective, st.filter, st.backdropFilter].some(v => v && v !== 'none') ||
    /paint|layout|strict|content/.test(st.contain) || /size/.test(st.containerType) || st.contentVisibility === 'auto' ||
    /transform|translate|rotate|scale|perspective|filter|contain/.test(st.willChange)
  const clipperOf = el => {
    const pos = getComputedStyle(el).position
    let e = el.parentElement
    if (pos === 'fixed') while (e && !holdsFixed(getComputedStyle(e))) e = e.parentElement
    else if (pos === 'absolute') while (e && getComputedStyle(e).position === 'static' && !holdsFixed(getComputedStyle(e))) e = e.parentElement
    return e
  }
  // Seen by a person: laid out, inside the page, not hidden, clipped or see-through anywhere up the tree.
  const shown = el => {
    const r = el.getBoundingClientRect()
    if (r.width < 2 || r.height < 2) return false
    const doc = document.documentElement
    if (r.right + scrollX <= 0 || r.bottom + scrollY <= 0 || r.left + scrollX >= doc.scrollWidth || r.top + scrollY >= doc.scrollHeight) return false
    for (let e = el; e && e.nodeType === 1; e = e.parentElement) {
      const st = getComputedStyle(e)
      if (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) < 0.1) return false
      if (st.clipPath && st.clipPath !== 'none') return false
      if (st.clip && st.clip !== 'auto') return false
    }
    // An ancestor that clips its content to nothing (height: 0; overflow: hidden) hides the control too. The page
    // edge is checked above, so the root's overflow, which belongs to the viewport, is skipped. Body's goes to the
    // viewport too, but only while the root's own overflow is visible.
    const bodyIsRoot = getComputedStyle(doc).overflow === 'visible'
    for (let e = clipperOf(el); e && e !== doc && !(e === document.body && bodyIsRoot); e = clipperOf(e)) {
      if (getComputedStyle(e).overflow !== 'visible') { const a = e.getBoundingClientRect(); if (a.width < 2 || a.height < 2) return false }
    }
    return true
  }
  // In the viewport, something else covers the control's center: a person cannot see what it holds.
  const covered = el => {
    const r = el.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2
    if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) return false
    const hit = document.elementFromPoint(x, y)
    return !!hit && hit !== el && !el.contains(hit) && !hit.contains(el)
  }
  // Text CSS draws or hides (::before or ::after content, zero-size or see-through text) reads differently on
  // screen than in the DOM, so the card flags it and the owner checks the picture of the control.
  // The control and everything inside it, since a child span can draw or hide the words just as well.
  const styledOne = e => {
    const pseudo = ['::before', '::after'].some(p => { const c = getComputedStyle(e, p).content; return c && c !== 'none' && c !== 'normal' && c !== '""' })
    const st = getComputedStyle(e)
    return pseudo || (e.textContent.trim() !== '' && parseFloat(st.fontSize) < 4) || st.color === 'transparent' || /rgba\(.*,\s*0\)$/.test(st.color)
  }
  const styled = el => styledOne(el) || [...el.querySelectorAll('*')].slice(0, 50).some(styledOne)
  const role = el => el.getAttribute('role') || (el.tagName === 'INPUT' ? INPUT_ROLE[el.type] ?? 'textbox' : TAG_ROLE[el.tagName]) || (el.isContentEditable ? 'textbox' : 'element')
  // The name a person reads. When an aria-label says something else, both show, so a button that reads
  // "Delete account" but is labelled "Cancel" cannot pass for Cancel on the owner's card.
  const name = el => {
    const aria = clean(el.getAttribute('aria-label') || el.getAttribute('aria-labelledby')?.split(' ').map(id => document.getElementById(id)?.innerText ?? '').join(' '))
    const labels = clean([...(el.labels ?? [])].map(l => l.innerText).join(' '))
    const text = clean(el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA' ? labels : el.innerText) || clean(['submit', 'button', 'reset'].includes(el.type) ? el.value : '')
    const seen = text || clean(el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('alt'))
    const base = aria && seen && aria.toLowerCase() !== seen.toLowerCase() ? `${seen} (labelled "${aria}")` : seen || aria
    return styled(el) ? `${base} (styled text: check the picture)` : base
  }
  const secret = el => el.type === 'password' || SECRET_AUTOCOMPLETE.test(el.getAttribute('autocomplete') ?? '') || SECRET_NAME.test(`${el.name ?? ''} ${el.id ?? ''}`)
  // A value a person cannot read on screen (a secret, text drawn invisible, a field under a cover) is not shown.
  const value = (el, r) => {
    if (secret(el) || (('value' in el) && (styledOne(el) || covered(el)))) return el.value ? '(filled)' : ''
    if (el.tagName === 'SELECT') return el.selectedOptions[0]?.text ?? ''
    if (el.type === 'checkbox' || el.type === 'radio') return el.checked ? 'checked' : 'not checked'
    if ('value' in el && r !== 'button' && r !== 'link') return String(el.value)
    if (el.isContentEditable) return clean(el.innerText).slice(0, 500)
    return undefined
  }
  const describe = el => {
    const r = role(el)
    const d = { ref: refFor(el), role: r, name: name(el) }
    const v = value(el, r)
    if (v !== undefined) d.value = v
    // Where a link goes, so a card for "Unsubscribe" also says which site it opens.
    if (el.tagName === 'A' && el.href) { try { d.to = new URL(el.href).hostname } catch { /* not a web address */ } }
    return d
  }
  const find = ref => { const el = byRef.get(Number(ref))?.deref(); return el?.isConnected ? el : undefined }
  const focusedEl = () => { const a = document.activeElement; return a && a !== document.body && a.matches?.(SEL) ? a : undefined }

  return {
    snapshot() {
      const elements = []
      for (const el of document.querySelectorAll('*')) {
        if (el.matches(CORE)) { if (el.type === 'hidden' || el.disabled || !shown(el)) continue }
        else {
          // A role-less clickable div (cursor: pointer) counts when it holds text and is the outermost pointer of
          // its group. Nothing inside a real control is listed again.
          if (!el.matches(SEL) && !(pointer(el) && !(el.parentElement && pointer(el.parentElement)) && clean(el.innerText))) continue
          if (el.parentElement?.closest(CORE) || !(clean(el.innerText) || el.getAttribute('aria-label')) || !shown(el)) continue
        }
        elements.push(describe(el))
      }
      return { title: document.title, url: location.href, elements }
    },
    // What a ref is now, and what has focus (where a key lands), for the hub's card and its re-check.
    describe(ref) {
      const el = find(ref), f = focusedEl()
      return { url: location.href, el: el ? describe(el) : undefined, focused: f ? describe(f) : undefined }
    },
    // Right before a click or typing, in one go: the same site and the same control as the owner approved, in view,
    // and not covered, so the click lands on it and not on an overlay or a frame laid over it.
    prepare(ref, focus, expect) {
      if (expect && location.hostname !== expect.host) return { refused: 'the tab moved to another site' }
      const el = find(ref)
      if (!el) return { refused: 'that control is no longer on the page: take a new snapshot' }
      const d = describe(el)
      if (expect && (d.role !== expect.role || d.name !== expect.name)) return { refused: 'the control changed since the owner said yes' }
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
      const r = el.getBoundingClientRect()
      const x = r.left + r.width / 2, y = r.top + r.height / 2
      const hit = document.elementFromPoint(x, y)
      if (!hit || (hit !== el && !el.contains(hit))) return { refused: 'something covers that control, so a click would land elsewhere' }
      if (focus) {
        el.focus()
        if (typeof el.select === 'function') el.select()
        else if (el.isContentEditable) { const range = document.createRange(); range.selectNodeContents(el); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range) }
      }
      showMark(x, y)
      return { url: location.href, x, y }
    },
    // Before a key: the same site, and focus still on the control the owner's card named. A key with focus on
    // nothing named (an iframe, a bare div) is refused: the owner could not see where it would land.
    keyTarget(expect) {
      if (expect && location.hostname !== expect.host) return { refused: 'the tab moved to another site' }
      const f = focusedEl(), d = f ? describe(f) : undefined
      if (!d) return { refused: 'no named control has focus, so it is not clear where the key would land: click the field first' }
      if (expect && (d.role !== expect.role || d.name !== expect.name)) return { refused: 'focus moved since the owner said yes' }
      const r = f.getBoundingClientRect()
      showMark(r.left + r.width / 2, r.top + r.height / 2)
      return { url: location.href }
    },
    // The control's box in the viewport, after scrolling it into view, so the extension can crop a picture of it.
    box(ref) {
      const el = find(ref)
      if (!el) return { refused: 'that control is no longer on the page: take a new snapshot' }
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
      const r = el.getBoundingClientRect()
      return { url: location.href, x: r.left, y: r.top, w: r.width, h: r.height, dpr: devicePixelRatio }
    },
  }
})()
