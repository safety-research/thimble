  // views-abstraction round 4: the action '@hook:<part>' opens one of the view's top-row hooks once, as an analyst's
  // first click on it would. color, filter and rows click the view kit's button (thimble.colorBy, filterBy, rows), else
  // the first visible control whose text starts with the hook's word, so that its menu opens; range narrows the kit's
  // time range (thimble.timeRange) to its middle with the '+' key twice, the keys its viewfinder takes, and needs no
  // click ('done'). shoot_view.py pastes this into findControl of a copy of scripts/view_shot.mjs, after the line that
  // clears data-thimble-act, where `w` (the action, lower case) and `sel` (the controls selector) exist. What it found
  // is window.__vabsClicked.
  if (w.startsWith('@hook:')) {
    const part = w.slice(6)
    const VW = window.innerWidth, VH = window.innerHeight
    const shown = (el) => {
      const r = el.getBoundingClientRect()
      const cs = getComputedStyle(el)
      return r.width >= 2 && r.height >= 2 && r.bottom > 0 && r.right > 0 && r.top < VH && r.left < VW &&
        cs.visibility === 'visible' && cs.display !== 'none'
    }
    const words = (el) => String(el.getAttribute('aria-label') || el.textContent || el.getAttribute('title') || el.value || '')
      .replace(/\s+/g, ' ').trim()
    if (part === 'range') {
      const win = [...document.querySelectorAll('.thimble-range-win')].find(shown)
      if (!win) return ''
      for (let i = 0; i < 2; i++) win.dispatchEvent(new KeyboardEvent('keydown', { key: '+', bubbles: true, cancelable: true }))
      window.__vabsClicked = { hook: 'range', how: 'kit', text: 'time range narrowed with + twice' }
      return 'done'
    }
    const kit = {
      color: 'button.thimble-colour-by:not(.thimble-filter-by):not(.thimble-rows-by)',
      filter: 'button.thimble-filter-by',
      rows: 'button.thimble-rows-by',
    }
    const lead = { color: /^colou?r\b/i, filter: /^filter\b/i, rows: /^(rows|group)\b/i }
    if (!kit[part]) return ''
    let how = 'kit'
    let pick = [...document.querySelectorAll(kit[part])].find(shown)
    if (!pick) {
      how = 'text'
      pick = [...document.querySelectorAll(sel)].find((el) => el.tagName !== 'SELECT' && shown(el) && lead[part].test(words(el)))
    }
    if (!pick) return ''
    window.__vabsClicked = { hook: part, how, tag: pick.tagName.toLowerCase(), text: words(pick).slice(0, 100) }
    pick.setAttribute('data-thimble-act', '')
    return 'click'
  }
