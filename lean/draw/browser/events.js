// events.js: the browser surface's events for a card program (draw/kit.js k.on). A page draws a card with svg.js, then
// hands its element here; what the person does on it comes back as the event the program's handlers take:
//
//   takes(drawing, event)          whether the program has a handler the event reaches (its key, 'press:<id>', 'brush')
//   keyName(e)                     a keydown as a handler names it ('j', 'space', 'return')
//   brushValue(rect, clientX)      where a point of a brush area reads, in the area's own units (data-min..data-max)
//   attachBrush(el, onEvent)       a drag across a brush area (svg.js's .dk-brush) draws a band while it moves and
//                                  ends as {type: 'brush', id, from, to}; returns a function that detaches it. `el`
//                                  holds the drawing and is not itself redrawn (the band is its child)
//
// No framework, no network: the program runs in the page's sandbox (browser/sandbox.js) with the event, and the page
// keeps the state it answers with (and posts it to the terminal, so both surfaces show the same).

export function takes(drawing, event) {
  const on = (drawing && drawing.on) || []
  if (!event || !on.length) return false
  const names = []
  if (event.type === 'key' && event.key) names.push(String(event.key))
  if (event.type) names.push(String(event.type))
  if (event.type && (event.region || event.id)) names.push(`${event.type}:${event.region || event.id}`)
  return on.some(h => names.includes(h.name))
}

export function keyName(e) {
  if (!e || e.ctrlKey || e.metaKey || e.altKey) return ''
  if (e.key === ' ') return 'space'
  if (e.key === 'Enter') return 'return'
  if (e.key === 'Escape') return 'esc'
  return e.key && e.key.length === 1 ? e.key : String(e.key || '').toLowerCase()
}

export function brushValue(rect, clientX) {
  const box = rect.getBoundingClientRect()
  const f = Math.max(0, Math.min(1, (clientX - box.left) / (box.width || 1)))
  const min = Number(rect.getAttribute('data-min')), max = Number(rect.getAttribute('data-max'))
  if (rect.getAttribute('data-log') === '1' && min > 0 && max > 0) return Math.pow(10, Math.log10(min) + f * (Math.log10(max) - Math.log10(min)))
  return min + f * (max - min)
}

const round = v => (Math.abs(v) >= 100 ? Math.round(v) : +v.toPrecision(4))

export function attachBrush(el, onEvent) {
  let drag = null
  const band = document.createElement('div')
  band.style.cssText = 'position:absolute;pointer-events:none;background:rgba(81,53,255,.14);border-left:1px solid rgba(81,53,255,.6);border-right:1px solid rgba(81,53,255,.6);display:none'
  if (getComputedStyle(el).position === 'static') el.style.position = 'relative'
  el.appendChild(band)
  const place = (x0, x1) => {
    const host = el.getBoundingClientRect(), box = drag.rect.getBoundingClientRect()
    const a = Math.max(box.left, Math.min(x0, x1)), b = Math.min(box.right, Math.max(x0, x1))
    band.style.left = `${a - host.left}px`
    band.style.width = `${Math.max(1, b - a)}px`
    band.style.top = `${box.top - host.top}px`
    band.style.height = `${box.height}px`
    band.style.display = 'block'
  }
  const down = e => {
    const rect = e.target && e.target.closest ? e.target.closest('.dk-brush') : null
    if (!rect || e.button !== 0) return
    e.preventDefault()
    drag = { rect, x0: e.clientX }
    place(e.clientX, e.clientX)
  }
  const move = e => { if (drag) place(drag.x0, e.clientX) }
  const up = e => {
    if (!drag) return
    const d = drag
    drag = null
    if (Math.abs(e.clientX - d.x0) < 4) { band.style.display = 'none'; return }
    const a = brushValue(d.rect, Math.min(d.x0, e.clientX)), b = brushValue(d.rect, Math.max(d.x0, e.clientX))
    // the program draws the range it kept: the band goes once the drawing comes back
    setTimeout(() => { band.style.display = 'none' }, 400)
    onEvent({ type: 'brush', id: d.rect.getAttribute('data-brush'), from: round(a), to: round(b) })
  }
  el.addEventListener('mousedown', down)
  window.addEventListener('mousemove', move)
  window.addEventListener('mouseup', up)
  return () => {
    el.removeEventListener('mousedown', down)
    window.removeEventListener('mousemove', move)
    window.removeEventListener('mouseup', up)
    band.remove()
  }
}
