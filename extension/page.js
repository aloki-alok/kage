// Injected into a page's isolated world (chrome.scripting, files: ['page.js']), where the page's own scripts cannot
// reach. Refs live here, in a Map the page cannot see or forge, not in DOM attributes a page could copy or preset.
// Defined once per page; later injections reuse it, so a ref stays bound to its element while the page lives.
globalThis.__kage ??= (() => {
  const byRef = new Map()        // ref -> WeakRef(element)
  const refOf = new WeakMap()    // element -> ref
  let next = 1
  const SEL = 'a[href], button, input, select, textarea, summary, [role=button], [role=link], [role=checkbox], [role=radio], [role=tab], [role=menuitem], [role=option], [role=switch], [role=combobox], [role=textbox], [role=searchbox], [contenteditable=""], [contenteditable=true]'
  const TAG_ROLE = { A: 'link', BUTTON: 'button', SELECT: 'combobox', TEXTAREA: 'textbox', SUMMARY: 'button' }
  const INPUT_ROLE = { checkbox: 'checkbox', radio: 'radio', submit: 'button', button: 'button', reset: 'button', image: 'button', range: 'slider', search: 'searchbox' }
  // Values Kage never sees: passwords, card details, one-time codes, and fields named like tokens.
  const SECRET_AUTOCOMPLETE = /(^|\s)(cc-|one-time-code|current-password|new-password)/
  const SECRET_NAME = /otp|token|csrf|secret|cvc|cvv|card.?num|ssn|\bpin\b|passw/i

  const clean = s => (s ?? '').replace(/\s+/g, ' ').trim()
  const refFor = el => {
    let ref = refOf.get(el)
    if (!ref) { ref = next++; refOf.set(el, ref); byRef.set(ref, new WeakRef(el)) }
    return ref
  }
  // Seen by a person: laid out, not hidden, not see-through anywhere up the tree.
  const shown = el => {
    const r = el.getBoundingClientRect()
    if (r.width < 2 || r.height < 2) return false
    for (let e = el; e && e.nodeType === 1; e = e.parentElement) {
      const st = getComputedStyle(e)
      if (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) < 0.1) return false
    }
    return true
  }
  const role = el => el.getAttribute('role') || (el.tagName === 'INPUT' ? INPUT_ROLE[el.type] ?? 'textbox' : TAG_ROLE[el.tagName]) || (el.isContentEditable ? 'textbox' : 'element')
  // The name a person reads. When an aria-label says something else, both show, so a button that reads
  // "Delete account" but is labelled "Cancel" cannot pass for Cancel on the owner's card.
  const name = el => {
    const aria = clean(el.getAttribute('aria-label') || el.getAttribute('aria-labelledby')?.split(' ').map(id => document.getElementById(id)?.innerText ?? '').join(' '))
    const labels = clean([...(el.labels ?? [])].map(l => l.innerText).join(' '))
    const text = clean(el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA' ? labels : el.innerText) || clean(['submit', 'button', 'reset'].includes(el.type) ? el.value : '')
    const seen = text || clean(el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('alt'))
    if (aria && seen && aria.toLowerCase() !== seen.toLowerCase()) return `${seen} (labelled "${aria}")`
    return seen || aria
  }
  const secret = el => el.type === 'password' || SECRET_AUTOCOMPLETE.test(el.getAttribute('autocomplete') ?? '') || SECRET_NAME.test(`${el.name ?? ''} ${el.id ?? ''}`)
  const value = (el, r) => {
    if (secret(el)) return el.value ? '(filled)' : ''
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
    return d
  }
  const find = ref => { const el = byRef.get(Number(ref))?.deref(); return el?.isConnected ? el : undefined }
  const focusedEl = () => { const a = document.activeElement; return a && a !== document.body && a.matches?.(SEL) ? a : undefined }

  return {
    snapshot() {
      const elements = []
      for (const el of document.querySelectorAll(SEL)) {
        if (el.type === 'hidden' || el.disabled || !shown(el)) continue
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
      return { url: location.href, x, y }
    },
    // Before a key: the same site, and focus still on the control the owner's card named.
    keyTarget(expect) {
      if (expect && location.hostname !== expect.host) return { refused: 'the tab moved to another site' }
      const f = focusedEl(), d = f ? describe(f) : undefined
      if (expect && (d?.role !== expect.role || d?.name !== expect.name)) return { refused: 'focus moved since the owner said yes' }
      return { url: location.href }
    },
  }
})()
