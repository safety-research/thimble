  // views-abstraction: the action '@record' clicks the first record the page shows, as an analyst's first click on the
  // overview would: the first visible element with a data-anchor, or the clickable element around it (a control, or
  // one with a pointer cursor). shoot_view.py pastes this into findControl of a copy of scripts/view_shot.mjs, after
  // the line that clears data-thimble-act, where `w` (the action, lower case) and `sel` (the controls selector) exist.
  if (w === '@record') {
    const VW = window.innerWidth, VH = window.innerHeight
    const shown = (el) => {
      const r = el.getBoundingClientRect()
      const cs = getComputedStyle(el)
      return r.width >= 2 && r.height >= 2 && r.bottom > 0 && r.right > 0 && r.top < VH && r.left < VW &&
        cs.visibility === 'visible' && cs.display !== 'none'
    }
    const clickable = (el) => {
      for (let a = el, i = 0; a && a !== document.body && i < 5; a = a.parentElement, i++) {
        if (a.matches(sel) || getComputedStyle(a).cursor === 'pointer') return a
      }
      return null
    }
    const found = [...document.querySelectorAll('[data-anchor]')].filter(shown)
    let pick = null
    for (const el of found) {
      const c = clickable(el)
      if (c) { pick = c; break }
    }
    if (!pick && found.length) pick = found[0]
    if (!pick) return ''
    const anchored = pick.hasAttribute('data-anchor') ? pick : (pick.querySelector('[data-anchor]') || pick.closest('[data-anchor]'))
    window.__vabsClicked = {
      anchor: anchored ? anchored.getAttribute('data-anchor') : null,
      tag: pick.tagName.toLowerCase(),
      text: (pick.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 100),
    }
    pick.setAttribute('data-thimble-act', '')
    return 'click'
  }
