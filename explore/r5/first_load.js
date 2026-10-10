// views-abstraction: what greets the analyst in the first viewport of a view's frame, as a crude overload measure.
// shoot_view.py appends this function to a copy of scripts/view_shot.mjs and adds its result to each state as
// `first_load`. It runs in the frame (frame.evaluate), so it must stay self-contained.
function firstLoad({ sel }) {
  const W = window.innerWidth, H = window.innerHeight
  const inView = (r) => r.width > 1 && r.height > 1 && r.right > 0 && r.bottom > 0 && r.left < W && r.top < H
  const vis = (el) => {
    for (let a = el; a && a !== document.documentElement; a = a.parentElement) {
      const cs = getComputedStyle(a)
      if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false
    }
    return true
  }
  const ctl = [...document.querySelectorAll(sel)].filter((e) => inView(e.getBoundingClientRect()) && vis(e))
  const range = document.createRange()
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
  let texts = 0, words = 0, prose = 0
  const proseEx = []
  for (let t = walker.nextNode(); t; t = walker.nextNode()) {
    const v = (t.nodeValue || '').replace(/\s+/g, ' ').trim()
    if (!v || !t.parentElement || !vis(t.parentElement)) continue
    range.selectNodeContents(t)
    const r = range.getBoundingClientRect()
    if (!inView(r)) continue
    texts++
    const n = v.split(' ').length
    words += n
    if (n >= 8) { prose++; if (proseEx.length < 5) proseEx.push(v.slice(0, 80)) }
  }
  const chips = [...document.querySelectorAll('.chip,[class*="chip"]')].filter((e) => inView(e.getBoundingClientRect()) && vis(e)).length
  const anchors = new Set()
  for (const e of document.querySelectorAll('[data-anchor]')) if (inView(e.getBoundingClientRect()) && vis(e)) anchors.add(e.getAttribute('data-anchor'))
  const marks = [...document.querySelectorAll('svg circle, svg rect, svg path, svg line, svg polygon, svg ellipse')]
    .filter((e) => inView(e.getBoundingClientRect())).length
  const canvases = [...document.querySelectorAll('canvas')].filter((e) => inView(e.getBoundingClientRect()) && vis(e)).length
  const hues = new Set()
  const sat = (c) => {
    const m = /rgba?\(([^)]+)\)/.exec(c || ''); if (!m) return null
    const [r, g, b, a] = m[1].split(',').map(Number); if (a === 0) return null
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b); if (mx - mn < 40) return null
    return `${Math.round(r / 32)},${Math.round(g / 32)},${Math.round(b / 32)}`
  }
  let scanned = 0
  for (const e of document.querySelectorAll('body *')) {
    if (scanned++ > 20000) break
    const r = e.getBoundingClientRect(); if (!inView(r)) continue
    const cs = getComputedStyle(e)
    for (const c of [cs.backgroundColor, cs.fill, cs.stroke, cs.color]) { const k = sat(c); if (k) hues.add(k) }
  }
  // round 4: which of the view kit's hooks the page has, and whether a menu or the side panel is open now
  const any = (s) => [...document.querySelectorAll(s)].some((e) => inView(e.getBoundingClientRect()) && vis(e))
  return {
    width: W, height: H, controls: ctl.length,
    control_texts: ctl.map((e) => (e.getAttribute('aria-label') || e.textContent || e.value || '').replace(/\s+/g, ' ').trim().slice(0, 30)).slice(0, 80),
    text_nodes: texts, words, prose_blocks: prose, prose_examples: proseEx, chips, anchored_in_view: anchors.size,
    svg_marks: marks, canvases, hues: hues.size, page_height: document.documentElement.scrollHeight,
    kit: {
      color: !!document.querySelector('button.thimble-colour-by:not(.thimble-filter-by):not(.thimble-rows-by)'),
      filter: !!document.querySelector('button.thimble-filter-by'), rows: !!document.querySelector('button.thimble-rows-by'),
      range: !!document.querySelector('.thimble-range-win'), side: !!document.querySelector('.thimble-side-host'),
    },
    menu_open: any('.thimble-colour-menu'), side_open: any('aside.thimble-side'),
  }
}
