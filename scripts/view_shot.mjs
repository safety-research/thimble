#!/usr/bin/env node
// A view's page loaded headless, for a view's checks, its review and the screenshot tool (backend/app/views.py
// shoot_states), and a video's film for the frames the writer looks at (backend/app/video.py), in the headless Chromium
// of the frontend's Playwright (frontend/node_modules, which scripts/install.sh installs).
//   node scripts/view_shot.mjs --frame <html> --states <json> [--viewport <w>x<h>] [--media <url>]
// --states names a JSON list of states, [{out, open, actions?, viewport?}], each loaded on a fresh page of one browser,
// PAGES_AT_ONCE at a time:
// `open` is the place the page is sent once the frame is ready, `actions` the controls clicked in turn once it is quiet,
// each named by the text it shows (findControl), `viewport` {width, height} the state's own size in place of
// --viewport, `out` the PNG written (none without it), and `sweep` true to try, once the actions are done, every
// choice of the view kit's controls the page mounted (thimble.__choices: Color by's Off, fields and labels, Rows' and
// Filter by's None, fields and labels), each in turn, the page quiet again after each.
// The page plays the part frontend/src/files/ViewerFrame.tsx plays in the browser: it puts the frame document (the view
// page with the bridge, views.frame_document) in a sandboxed iframe with the theme's tokens and the app's two faces, and
// asks the server over stdin and stdout, one JSON line each way, for what the page needs:
//   {"fetch": id, "state": i, "query": ...}   answered {"id", "data"} or {"id", "error"}: reader.records for the state
//   {"marks": id, "state": i, "refs": [...]}  answered {"id", "marks", "on", "filter", "all", "palette"}: the marks of
//                                             those refs, the labels that are on in the state and the palette, sent
//                                             to the page as `labels`
//   {"media": id, "path": ...}                answered {"id", "file", "type", "size"} or {"id", "error"}: the file a
//                                             request to the --media URL (thimble.mediaUrl) names, served from here,
//                                             a Range request with the bytes it asks for (at most MEDIA_CHUNK)
// Every other request the page makes is refused, so a view that reaches for the network fails here as it would in the
// browser. A state is measured when its page has been quiet (no fetch or marks request in flight) for QUIET_MS after
// `open`, or HARD_MS has passed with no request in flight, and again after each action. One line ends the run:
// {"done": true, "states": [{ok, errors, fetches, height, refs, records, units, marked, hidden, shown, layout, controls,
// label_controls, painted, actions, fonts}]}: `refs` the distinct data-anchor refs the page reported, `records` those naming a record of a file
// (RECORD_REF: `<path>#L<n>`, `<db>#<table>/<key>`, `<pdf>#p<n>`, any `<path>#<fragment>`), `units` those naming one of
// the view's units (`view:<slug>/<key>`), `marked` the elements carrying a label's mark, `hidden` those the bridge hid or dimmed for the filter, `shown` what is on screen at the end
// (shownCounts), `layout` how its text fits (layoutCounts), `controls` the controls it shows (controlList),
// `label_controls` the elements whose data-label names a label that is on, shown or not, `painted`
// how many of the marked records in view show the label's colour in a picture of the frame (paintedMarks), `actions`
// each action with whether its control was found, `choices` with `sweep` each choice tried, {control, choice, errors},
// its errors those the page reported while it settled (they are not among the state's own), `fonts` whether Hanken
// Grotesk was loaded in the frame, and
// `self_labels` the ops of the label calls the page made by itself, outside the actions (the bridge's labelRefused, or
// a labelCall while no action was clicked), which the page answers as refused.
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { createInterface } from 'node:readline'

const require = createRequire(new URL('../frontend/package.json', import.meta.url))
const { chromium } = require('playwright')

const QUIET_MS = 900
const SWEEP_QUIET_MS = 250 // the quiet after a choice the sweep tried, before the next
const SWEEP_MS = 10_000 // the most one choice of the sweep waits for its page
const SWEEP_MAX = 40 // the choices one sweep tries
const MIN_MS = 1200
const HARD_MS = 25_000
// a fetch or marks request still unanswered at HARD_MS is waited for this long, since a view's data calls have no time
// limit (backend views.ANSWER_WAIT_S)
const ANSWER_MS = 600_000
const READY_MS = 10_000
const PAGES_AT_ONCE = 3 // states loaded side by side, each on its own page
const MEDIA_CHUNK = 4 * 1024 * 1024 // bytes of one Range answer
const MEDIA_WHOLE_MAX = 32 * 1024 * 1024 // a request without Range (an <img>) gets a file up to this size whole
const CHECK_PAGE = 'http://thimble.invalid/view-check' // the page that holds the frame (shootState), never on the network
// a ref naming one record of a file: a line of any file, or a fragment of a file whose name has an extension (backend
// records.is_record_ref)
const RECORD_REF = /^(?!(?:view|card|cell|concept|report|chat|call|group|ui):)[^\s#][^#\n]*(?:#L[1-9]\d*|\.[A-Za-z0-9]{1,8}#\S+)$/

// An error's message without the boxed notice Playwright adds to a failed launch, which names an install command: the
// server hands these messages to models.
const plain = (e) => String(e && e.message ? e.message : e).split('\n').filter((l) => !/^[╔║╚]/.test(l)).join('\n')

const BAR = 3 // px, the bridge's label bar (viewer_bridge.js BAR)
const PAINT_MAX = 40 // marked elements in view whose pixels are looked at
const PAINT_TOL = 64 // how far, summed over r, g and b, a pixel may be from the label's colour and still show it

// The marked elements in the frame's view whose pixels show whether the label's mark can be seen, as the outermost
// visible element per ref: {due, list: [{ref, own, svg, record, box: {l, t, r, b}, body, rgb}]}, `due` the refs whose
// `marks` entry has a bar, data-anchor-unmarked ones included, `box` the part of the frame where thimble's mark shows
// and `body` the element, each cut to the view and to the boxes that hide overflow around it. `box` is the strip along
// the left edge where the bridge draws its bar, the element and the halo around it for SVG, and the element itself for
// data-anchor-unmarked, which draws the label's colour itself. With `scroll`, when none is in view, the first is scrolled into view and {retry: true} comes back.
// Runs in the frame.
function markTargets({ marks, record, bar, max, scroll }) {
  const RECORD = new RegExp(record)
  const UNIT = /^view:[^/]+\/.+/
  const W = document.documentElement.clientWidth
  const H = window.innerHeight
  const clips = new Map()
  const clipOf = (el) => {
    if (!el || el === document.documentElement || el === document.body) return { l: 0, t: 0, r: W, b: H }
    if (clips.has(el)) return clips.get(el)
    let box = clipOf(el.parentElement)
    const cs = getComputedStyle(el)
    if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') {
      const r = el.getBoundingClientRect()
      box = { l: Math.max(box.l, r.left), t: Math.max(box.t, r.top), r: Math.min(box.r, r.right), b: Math.min(box.b, r.bottom) }
    }
    clips.set(el, box)
    return box
  }
  const probe = document.createElement('span')
  probe.style.display = 'none'
  document.body.appendChild(probe)
  const rgbOf = (colour) => {
    probe.style.color = ''
    probe.style.color = colour
    const m = /rgba?\(([^)]+)\)/.exec(getComputedStyle(probe).color || '')
    return m ? m[1].split(',').slice(0, 3).map((x) => Math.round(Number(x))) : null
  }
  const alpha = (c) => {
    const m = /rgba?\(([^)]+)\)/.exec(c || '')
    if (!m) return 0
    const p = m[1].split(/[\s,/]+/).filter(Boolean)
    return p.length > 3 ? Number(p[3]) : 1
  }
  // whether an element draws anything over what lies under it: a background, an image or media, or an SVG shape's fill
  const paints = (e) => {
    const cs = getComputedStyle(e)
    if (cs.visibility === 'hidden' || !(Number(cs.opacity) > 0)) return false
    if (e instanceof SVGElement) return !(e instanceof SVGTextContentElement) && e instanceof SVGGeometryElement && alpha(cs.fill) * Number(cs.fillOpacity || 1) > 0
    return /^(IMG|VIDEO|CANVAS|IFRAME)$/.test(e.tagName) || alpha(cs.backgroundColor) > 0 || cs.backgroundImage !== 'none'
  }
  const tops = new Map()
  for (const el of document.querySelectorAll('[data-anchor]')) {
    const ref = el.getAttribute('data-anchor')
    if (!ref || tops.has(ref) || el.tagName === 'CANVAS' || el.closest('[data-thimble-drop]')) continue
    if (!RECORD.test(ref) && !UNIT.test(ref)) continue
    const m = marks[ref]
    if (!m || typeof m.bar !== 'string' || !m.bar) continue
    let top = el
    for (let a = el.parentElement; a; a = a.parentElement) if (a.getAttribute('data-anchor') === ref) top = a
    const r = top.getBoundingClientRect()
    const cs = getComputedStyle(top)
    if (r.width <= 0 || r.height <= 0 || cs.visibility === 'hidden' || cs.display === 'none') continue
    tops.set(ref, { el: top, r, colour: m.bar })
  }
  const list = []
  for (const [ref, { el, r, colour }] of tops) {
    const own = el.hasAttribute('data-anchor-unmarked')
    const svg = el instanceof SVGElement
    const c = clipOf(el.parentElement)
    const cut = (x) => ({ l: Math.max(x.l, c.l, 0), t: Math.max(x.t, c.t, 0), r: Math.min(x.r, c.r, W), b: Math.min(x.b, c.b, H) })
    const body = cut({ l: r.left, t: r.top, r: r.right, b: r.bottom })
    let box = body
    if (svg) box = cut({ l: r.left - 4, t: r.top - 4, r: r.right + 4, b: r.bottom + 4 })
    else if (!own) box = cut({ l: r.left - bar - 1, t: r.top, r: r.left + bar + 1, b: r.bottom })
    // in view where a part of it is left by the boxes that clip it and no element that paints over it, such as a
    // sticky header the list scrolls under or another mark drawn on top, covers that part's centre; a clear layer, such
    // as one that catches a chart's zoom, covers nothing
    let inView = body.r - body.l > 1 && body.b - body.t > 1
    if (inView) {
      const stack = document.elementsFromPoint((body.l + body.r) / 2, (body.t + body.b) / 2)
      const at = stack.findIndex((e) => e === el || el.contains(e) || e.contains(el))
      if (at > 0) inView = !stack.slice(0, at).some(paints)
    }
    list.push({ ref, own, svg, record: RECORD.test(ref), box, body, rgb: rgbOf(colour), inView, el })
  }
  probe.remove()
  const due = list.length
  const shown = list.filter((x) => x.inView)
  if (!shown.length && list.length && scroll) {
    list[0].el.scrollIntoView({ block: 'center', inline: 'center' })
    return { retry: true }
  }
  return { due, list: shown.slice(0, max).map(({ el, inView, ...x }) => x) }
}

// How many of the targets show their label's mark, from two PNGs of the frame (base64, one pixel per CSS px), `on` as
// it is and `off` with the bridge's label styles switched off: {checked, seen, unseen: [ref...]}. A target shows it
// where pixels of its `box` move towards the label's colour (by MOVE, summed over r, g and b) when the styles are on,
// as many as the bar's strip is high, up to 24, for a bar, and 6 for the halo of an SVG mark; or where the page draws
// the colour itself, 8 pixels of its `body` within `tol` of it. An element marked data-anchor-unmarked that names a
// unit is excused when a record in view shows its mark, since a unit's mark is its records'. Runs in the page.
async function paintedCount({ on, off, targets, tol }) {
  const MOVE = 30
  const pixels = async (png) => {
    const img = new Image()
    img.src = 'data:image/png;base64,' + png
    await img.decode()
    const cv = document.createElement('canvas')
    cv.width = img.naturalWidth
    cv.height = img.naturalHeight
    const g = cv.getContext('2d', { willReadFrequently: true })
    g.drawImage(img, 0, 0)
    return { w: cv.width, h: cv.height, d: g.getImageData(0, 0, cv.width, cv.height).data }
  }
  const a = await pixels(on)
  const b = await pixels(off)
  const dist = (d, i, c) => Math.abs(d[i] - c[0]) + Math.abs(d[i + 1] - c[1]) + Math.abs(d[i + 2] - c[2])
  const out = { checked: 0, seen: 0, unseen: [] }
  const units = []
  let records = 0
  for (const t of targets) {
    const l = Math.max(0, Math.floor(t.box.l))
    const top = Math.max(0, Math.floor(t.box.t))
    const r = Math.min(a.w, Math.ceil(t.box.r))
    const btm = Math.min(a.h, Math.ceil(t.box.b))
    let moved = 0
    for (let y = top; t.rgb && !t.own && b.w === a.w && y < btm; y++)
      for (let x = l; x < r; x++) {
        const i = (y * a.w + x) * 4
        if (dist(a.d, i, t.rgb) + MOVE <= dist(b.d, i, t.rgb)) moved++
      }
    let drawn = 0
    const [bl, bt, br, bb] = [Math.max(0, Math.floor(t.body.l)), Math.max(0, Math.floor(t.body.t)), Math.min(a.w, Math.ceil(t.body.r)), Math.min(a.h, Math.ceil(t.body.b))]
    for (let y = bt; t.rgb && y < bb && drawn < 8; y++)
      for (let x = bl; x < br && drawn < 8; x++) if (dist(a.d, (y * a.w + x) * 4, t.rgb) <= tol) drawn++
    out.checked++
    if ((!t.own && moved >= (t.svg ? 6 : Math.max(3, Math.min(24, btm - top)))) || drawn >= 8) {
      out.seen++
      if (t.record) records++
    } else if (t.own && !t.record) units.push(t.ref)
    else out.unseen.push(t.ref)
  }
  if (records) out.seen += units.length
  else out.unseen.push(...units)
  return out
}

// What the page shows at the end, counted once per ref on the outermost visible element that carries it (not a canvas,
// which takes no mark, and not one the bridge hid or dimmed for the filter): `records` and `units` anchored, `due` the
// refs whose `marks` entry has a bar, other than those whose outermost element is data-anchor-unmarked (the page draws
// the labels' colours on it itself), `drawn` those of them whose element carries the bridge's mark, `unkept` the
// records shown that the filter does not keep, other than those inside a unit it keeps, and `held` the records the view
// kit's lists that draw only the rows near their view hold, each row anchored as it is drawn (thimble.__held). Runs in
// the frame.
function shownCounts({ marks, record }) {
  const RECORD = new RegExp(record)
  const UNIT = /^view:[^/]+\/.+/
  const seen = new Map()
  for (const el of document.querySelectorAll('[data-anchor]')) {
    const ref = el.getAttribute('data-anchor')
    if (!ref || el.tagName === 'CANVAS' || el.closest('[data-thimble-drop]')) continue
    if (!RECORD.test(ref) && !UNIT.test(ref)) continue
    const r = el.getBoundingClientRect()
    if (r.width <= 0 || r.height <= 0) continue
    const cs = getComputedStyle(el)
    if (cs.visibility === 'hidden' || cs.display === 'none') continue
    let top = el
    let held = false
    for (let a = el.parentElement; a; a = a.parentElement) {
      const up = a.getAttribute('data-anchor')
      if (up === ref) top = a
      else if (up && UNIT.test(up) && marks[up] && marks[up].keep) held = true
    }
    const was = seen.get(ref)
    seen.set(ref, {
      drawn: (was && was.drawn) || top.hasAttribute('data-thimble-label'),
      held: (!was || was.held) && held,
      own: (!was || was.own) && top.hasAttribute('data-anchor-unmarked'),
    })
  }
  const out = { records: 0, units: 0, due: 0, drawn: 0, unkept: 0, held: 0 }
  for (const [ref, { drawn, held, own }] of seen) {
    const record = RECORD.test(ref)
    if (record) out.records++
    else out.units++
    const m = marks[ref]
    if (m && typeof m.bar === 'string' && m.bar && !own) {
      out.due++
      if (drawn) out.drawn++
    }
    if (record && !held && !(m && m.keep)) out.unkept++
  }
  try {
    out.held = window.thimble && typeof window.thimble.__held === 'function' ? Number(window.thimble.__held()) || 0 : 0
  } catch {
    out.held = 0
  }
  return out
}
// How the page's text fits its pane at the end: `overlaps`, the places where visible text is drawn over other visible
// text (not under an opaque element, as below a sticky header), with up to EXAMPLES of their pairs of texts; `cut`, the
// elements whose own text runs past a box that hides it without an ellipsis; `sideways`, the boxes that scroll sideways,
// with the start of their text; `overflow`, how many px the page is wider than its pane; `used`, the px across that its
// text and graphics span, of `width`; and `anchored`, the records and units it draws, of which `outside` are out of
// view until the analyst scrolls. Runs in the frame.
function layoutCounts() {
  const EXAMPLES = 5
  const ITEMS_MAX = 3000
  const W = document.documentElement.clientWidth
  const H = Math.max(window.innerHeight, document.documentElement.scrollHeight)
  const clips = new Map()
  const clipOf = (el) => {
    if (!el || el === document.documentElement || el === document.body) return { l: 0, t: 0, r: W, b: H }
    if (clips.has(el)) return clips.get(el)
    let box = clipOf(el.parentElement)
    const cs = getComputedStyle(el)
    if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') {
      const r = el.getBoundingClientRect()
      box = { l: Math.max(box.l, r.left), t: Math.max(box.t, r.top), r: Math.min(box.r, r.right), b: Math.min(box.b, r.bottom) }
    }
    clips.set(el, box)
    return box
  }
  const shown = new Map()
  const visible = (el) => {
    if (shown.has(el)) return shown.get(el)
    let ok = true
    for (let a = el; a && a !== document.documentElement && ok; a = a.parentElement) {
      const cs = getComputedStyle(a)
      if (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse' || Number(cs.opacity) === 0) ok = false
      if (a !== el && shown.has(a)) {
        ok = ok && shown.get(a)
        break
      }
    }
    shown.set(el, ok)
    return ok
  }
  const items = []
  let minL = Infinity
  let maxR = -Infinity
  const range = document.createRange()
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
  for (let t = walker.nextNode(); t && items.length < ITEMS_MAX; t = walker.nextNode()) {
    const text = (t.nodeValue || '').trim()
    const el = t.parentElement
    if (!text || !el || el.closest('script,style,noscript,template,title,option,datalist,select,textarea')) continue
    if (!visible(el)) continue
    const clip = clipOf(el)
    range.selectNodeContents(t)
    for (const r of range.getClientRects()) {
      const l = Math.max(r.left, clip.l)
      const top = Math.max(r.top, clip.t)
      const right = Math.min(r.right, clip.r)
      const b = Math.min(r.bottom, clip.b)
      if (right - l < 2 || b - top < 2) continue
      items.push({ l, t: top, r: right, b, el, node: t, text })
      minL = Math.min(minL, l)
      maxR = Math.max(maxR, right)
    }
  }
  for (const el of document.querySelectorAll('img,canvas,svg,video')) {
    if (el.parentElement && el.parentElement.closest('svg')) continue
    const r = el.getBoundingClientRect()
    if (r.width < 4 || r.height < 4 || !visible(el)) continue
    minL = Math.min(minL, Math.max(0, r.left))
    maxR = Math.max(maxR, Math.min(W, r.right))
  }
  const CELL = 64
  const grid = new Map()
  const opaque = (el) => {
    const tag = el.tagName
    if (tag === 'IMG' || tag === 'CANVAS' || tag === 'VIDEO') return true
    const m = /rgba?\(([^)]+)\)/.exec(getComputedStyle(el).backgroundColor || '')
    if (!m) return false
    const parts = m[1].split(',').map(Number)
    return parts.length < 4 || parts[3] >= 0.5
  }
  const covered = (a, b) => {
    const cx = (Math.max(a.l, b.l) + Math.min(a.r, b.r)) / 2
    const cy = (Math.max(a.t, b.t) + Math.min(a.b, b.b)) / 2
    if (cx < 0 || cy < 0 || cx >= W || cy >= window.innerHeight) return false
    const stack = document.elementsFromPoint(cx, cy)
    const ia = stack.findIndex((x) => x === a.el || a.el.contains(x))
    const ib = stack.findIndex((x) => x === b.el || b.el.contains(x))
    if (ia < 0 || ib < 0) return false
    const [low, at] = ia > ib ? [a.el, ia] : [b.el, ib]
    return stack.slice(0, at).some((x) => !x.contains(low) && opaque(x))
  }
  let overlaps = 0
  const pairs = []
  for (let i = 0; i < items.length; i++) {
    const a = items[i]
    const near = new Set()
    for (let gx = Math.floor(a.l / CELL); gx <= Math.floor(a.r / CELL); gx++)
      for (let gy = Math.floor(a.t / CELL); gy <= Math.floor(a.b / CELL); gy++) {
        const k = gx + ':' + gy
        for (const j of grid.get(k) || []) near.add(j)
        if (!grid.has(k)) grid.set(k, [])
        grid.get(k).push(i)
      }
    for (const j of near) {
      const b = items[j]
      if (b.node === a.node) continue
      const ix = Math.min(a.r, b.r) - Math.max(a.l, b.l)
      const iy = Math.min(a.b, b.b) - Math.max(a.t, b.t)
      if (ix <= 2 || iy <= 2) continue
      if (ix * iy < 0.25 * Math.min((a.r - a.l) * (a.b - a.t), (b.r - b.l) * (b.b - b.t))) continue
      if (covered(a, b)) continue
      overlaps++
      if (pairs.length < EXAMPLES) pairs.push([b.text.slice(0, 40), a.text.slice(0, 40)])
    }
  }
  let cut = 0
  const cuts = []
  for (const el of document.body.querySelectorAll('*')) {
    if (![...el.childNodes].some((n) => n.nodeType === 3 && n.nodeValue.trim())) continue
    const cs = getComputedStyle(el)
    if (!['hidden', 'clip'].includes(cs.overflowX) || cs.textOverflow === 'ellipsis') continue
    // the kit's table draws the year or the seconds a narrow column of times leaves out 0 wide on purpose; any other box
    // squeezed to nothing still cuts its text off
    if (el.classList.contains('thimble-table-cut') || el.scrollWidth <= el.clientWidth + 2 || !visible(el)) continue
    cut++
    if (cuts.length < EXAMPLES) cuts.push(el.textContent.replace(/\s+/g, ' ').trim().slice(0, 40))
  }
  let sideways = 0
  const wide = []
  for (const el of document.body.querySelectorAll('*')) {
    const cs = getComputedStyle(el)
    if (!['auto', 'scroll'].includes(cs.overflowX) || el.scrollWidth <= el.clientWidth + 20 || el.clientWidth < 100 || !visible(el)) continue
    if (el.parentElement && el.parentElement.closest('[data-thimble-sideways]')) continue
    el.setAttribute('data-thimble-sideways', '')
    sideways++
    if (wide.length < EXAMPLES) wide.push(el.textContent.replace(/\s+/g, ' ').trim().slice(0, 40))
  }
  for (const el of document.querySelectorAll('[data-thimble-sideways]')) el.removeAttribute('data-thimble-sideways')
  let anchored = 0
  let outside = 0
  const seen = new Set()
  for (const el of document.querySelectorAll('[data-anchor]')) {
    const ref = el.getAttribute('data-anchor')
    if (!ref || seen.has(ref) || (el.parentElement && el.parentElement.closest(`[data-anchor="${CSS.escape(ref)}"]`))) continue
    const r = el.getBoundingClientRect()
    if (r.width <= 0 || r.height <= 0 || !visible(el)) continue
    seen.add(ref)
    anchored++
    const clip = clipOf(el.parentElement)
    const view = { l: Math.max(clip.l, 0), t: Math.max(clip.t, 0), r: Math.min(clip.r, W), b: Math.min(clip.b, window.innerHeight) }
    if (Math.min(r.right, view.r) - Math.max(r.left, view.l) <= 0 || Math.min(r.bottom, view.b) - Math.max(r.top, view.t) <= 0) outside++
  }
  const overflow = Math.max(0, document.documentElement.scrollWidth - W)
  return { overlaps, pairs, cut, cuts, sideways, wide, overflow, used: maxR > minL ? Math.round(maxR - minL) : 0, width: W, anchored, outside }
}

const CONTROLS = 'button,[role=button],[role=tab],[role=radio],[role=switch],[role=checkbox],[role=menuitem],[role=option],select,input[type=checkbox],input[type=radio],summary,.seg-opt,a[href]'
const CONTROLS_MAX = 60

// The controls the page shows, each as the text it reads: a select as `<its chosen text> (select: <its options>)`. Runs
// in the frame.
function controlList({ sel, max }) {
  const name = (el) => (el.getAttribute('aria-label') || el.textContent || el.getAttribute('title') || el.value || '').replace(/\s+/g, ' ').trim().slice(0, 60)
  const out = []
  const seen = new Set()
  for (const el of document.querySelectorAll(sel)) {
    if (out.length >= max) break
    const r = el.getBoundingClientRect()
    const cs = getComputedStyle(el)
    if (r.width < 2 || r.height < 2 || cs.visibility !== 'visible' || cs.display === 'none') continue
    let text
    if (el.tagName === 'SELECT') {
      const opts = [...el.options].map((o) => o.text.replace(/\s+/g, ' ').trim()).filter(Boolean)
      text = `${(el.selectedOptions[0] && el.selectedOptions[0].text.trim()) || ''} (select: ${opts.slice(0, 12).join(', ')}${opts.length > 12 ? ', …' : ''})`
    } else if (el.tagName === 'INPUT') {
      text = el.labels && el.labels[0] ? el.labels[0].textContent.replace(/\s+/g, ' ').trim().slice(0, 60) : name(el)
    } else text = name(el)
    if (!text || seen.has(text)) continue
    seen.add(text)
    out.push(text)
  }
  return out
}

// Mark the control an action names for a click, or pick the option it names in its select: the first visible control
// whose text is the name, then an option of a select, then a control whose text holds it, then the smallest visible
// element whose text is the name. 'click', 'select' or '' when none is found. Runs in the frame.
function findControl({ want, sel }) {
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase()
  const w = norm(want)
  for (const el of document.querySelectorAll('[data-thimble-act]')) el.removeAttribute('data-thimble-act')
  const seen = (el) => {
    const r = el.getBoundingClientRect()
    const cs = getComputedStyle(el)
    return r.width >= 2 && r.height >= 2 && cs.visibility === 'visible' && cs.display !== 'none'
  }
  const text = (el) => norm(el.getAttribute('aria-label') || el.textContent || el.getAttribute('title') || el.value)
  const controls = [...document.querySelectorAll(sel)].filter(seen)
  let hit = controls.find((el) => el.tagName !== 'SELECT' && text(el) === w)
  if (!hit) {
    for (const s of document.querySelectorAll('select')) {
      const o = [...s.options].find((x) => norm(x.text) === w || norm(x.value) === w)
      if (o && seen(s)) {
        s.setAttribute('data-thimble-act', o.value)
        return 'select'
      }
    }
    hit = controls.find((el) => el.tagName !== 'SELECT' && w && text(el).includes(w))
  }
  if (!hit) {
    let best = null
    for (const el of document.body.querySelectorAll('*')) {
      if (norm(el.textContent) !== w || !seen(el)) continue
      if (!best || best.contains(el)) best = el
    }
    hit = best
  }
  if (!hit) return ''
  hit.setAttribute('data-thimble-act', '')
  return 'click'
}

// The tokens a view's page reads: frontend/src/lib/frame.ts VIEW_TOKENS, which this list follows.
const VIEW_TOKENS = [
  '--text-primary', '--text-secondary', '--text-tertiary', '--surface-card', '--bg-sub', '--bg-sunken', '--border-subtle', '--accent', '--font-body', '--font-mono',
  '--ink-rgb', '--accent-hover', '--text-accent', '--text-link', '--text-on-accent', '--text-on-inverse', '--text-placeholder', '--surface-hover', '--surface-selected', '--surface-inverse', '--raised-bg', '--raised-ring', '--track-bg', '--chip-edge', '--chip-bg', '--chip-edge-hover',
  '--chip-bg-hover', '--text-xs', '--text-ui-sm', '--text-sm', '--text-lg', '--text-mono', '--text-mono-sm', '--h-chip', '--h-control', '--control-sm', '--h-row', '--radius-chip', '--radius-seg', '--radius-ui', '--radius-card', '--transition-color',
  '--accent-soft', '--hl-bg', '--hl-bg-strong', '--border-hairline', '--border-strong', '--bg-panel', '--overlay-bg', '--overlay-edge', '--shadow-popover', '--text-eyebrow', '--radius-hl', '--status-positive', '--status-negative', '--status-warning',
  '--viz-1', '--viz-2', '--viz-3', '--viz-4', '--viz-5', '--viz-6', '--viz-7', '--viz-ink-1', '--viz-ink-2', '--viz-ink-3', '--viz-ink-4',
  '--viz-seq-1', '--viz-seq-2', '--viz-seq-3', '--viz-seq-4', '--viz-seq-5', '--viz-div-1', '--viz-div-2', '--viz-div-3', '--viz-div-4', '--viz-div-5',
  '--viz-other', '--viz-highlight', '--viz-grid', '--viz-axis', '--viz-label', '--viz-annotation', '--viz-font', '--viz-font-label', '--viz-size', '--viz-size-title', '--viz-line', '--viz-bar-radius',
  '--label-1', '--label-2', '--label-3', '--label-4', '--label-5', '--label-6', '--label-7', '--label-8', '--label-9', '--label-10', '--label-11', '--label-12', '--label-13', '--label-14', '--label-15', '--label-16', '--label-17', '--label-18', '--label-none',
]
// The app's faces (frontend/src/styles/fonts.css), latin subset, inlined as data URLs as ViewerFrame inlines them.
const FACES = [
  ['Hanken Grotesk', 'hanken-grotesk', [400, 500, 600]],
  ['Geist Mono', 'geist-mono', [400, 500]],
]

function args(argv) {
  const out = { frame: null, states: null, media: null, viewport: { width: 800, height: 700 } }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => argv[++i]
    if (a === '--frame') out.frame = next()
    else if (a === '--states') out.states = next()
    else if (a === '--media') out.media = next()
    else if (a === '--viewport') {
      const m = /^(\d+)x(\d+)$/.exec(next() || '')
      if (m) out.viewport = { width: Number(m[1]), height: Number(m[2]) }
    }
  }
  if (!out.frame || !out.states) throw new Error('usage: view_shot.mjs --frame <html> --states <json> [--viewport WxH] [--media <url>]')
  return out
}

const say = (obj) => process.stdout.write(JSON.stringify(obj) + '\n')

function faces() {
  const rules = []
  for (const [family, pkg, weights] of FACES) {
    for (const w of weights) {
      try {
        const file = new URL(`../frontend/node_modules/@fontsource/${pkg}/files/${pkg}-latin-${w}-normal.woff2`, import.meta.url)
        const data = readFileSync(file).toString('base64')
        rules.push(`@font-face{font-family:'${family}';font-style:normal;font-weight:${w};font-display:block;src:url(data:font/woff2;base64,${data}) format('woff2')}`)
      } catch {
        // a missing face leaves the fallback, which the state's `fonts` reports
      }
    }
  }
  return rules.join('')
}

/** The bytes of `file` a media request asks for: {status, headers, body}, a 206 with Content-Range for a Range request
 * (its end cut to MEDIA_CHUNK past its start), the whole file for one without, and 416 past the end. */
async function mediaAnswer(file, type, size, rangeHeader) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader || '')
  let start = 0
  let end = size - 1
  let partial = false
  if (m && (m[1] || m[2])) {
    partial = true
    if (m[1]) {
      start = Number(m[1])
      if (m[2]) end = Math.min(Number(m[2]), size - 1)
    } else start = Math.max(0, size - Number(m[2])) // bytes=-N, the last N bytes
    if (start >= size || start > end) return { status: 416, headers: { 'content-range': `bytes */${size}` }, body: '' }
    end = Math.min(end, start + MEDIA_CHUNK - 1)
  } else if (size > MEDIA_WHOLE_MAX) {
    return { status: 204, headers: {}, body: '' } // too large to send whole: the element shows nothing, as a blank player
  }
  const fh = await open(file, 'r')
  try {
    const body = Buffer.alloc(end - start + 1)
    const { bytesRead } = await fh.read(body, 0, body.length, start)
    const headers = { 'content-type': type, 'accept-ranges': 'bytes', 'content-length': String(bytesRead) }
    if (partial) headers['content-range'] = `bytes ${start}-${start + bytesRead - 1}/${size}`
    return { status: partial ? 206 : 200, headers, body: body.subarray(0, bytesRead) }
  } finally {
    await fh.close()
  }
}

const answers = new Map()
let seq = 0
createInterface({ input: process.stdin }).on('line', (line) => {
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    return
  }
  const fn = answers.get(msg.id)
  if (fn) {
    answers.delete(msg.id)
    fn(msg)
  }
})
/** One request to the server and its answer. */
function ask(kind, body) {
  const id = `${kind[0]}${++seq}`
  return new Promise((resolve) => {
    answers.set(id, resolve)
    say({ [kind]: id, ...body })
  })
}

async function shootState(browser, opt, doc, state, i) {
  const errors = []
  let fetches = 0
  let inflight = 0
  let lastActivity = Date.now()
  const page = await browser.newPage({ viewport: state.viewport || opt.viewport })
  try {
    // no WebRTC in any frame, the page's own nested ones too, since no policy covers it and page.route never sees it
    await page.addInitScript(() => {
      for (const k of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'RTCDataChannel'])
        try {
          Object.defineProperty(window, k, { value: undefined })
        } catch {}
    })
    const isMedia = (url) => !!opt.media && (url === opt.media || url.startsWith(opt.media + '?'))
    await page.route('**/*', async (route) => {
      const req = route.request()
      if (!isMedia(req.url())) return route.abort()
      const path = new URL(req.url()).searchParams.get('path') || ''
      const msg = await ask('media', { path })
      if (msg.error) {
        errors.push(`media ${path}: ${msg.error}`.slice(0, 400))
        return route.fulfill({ status: 404, body: '' })
      }
      try {
        await route.fulfill(await mediaAnswer(msg.file, msg.type, msg.size, req.headers()['range']))
      } catch (e) {
        errors.push(`media ${path}: ${e && e.message ? e.message : e}`.slice(0, 400))
        await route.fulfill({ status: 500, body: '' }).catch(() => {})
      }
    })
    page.on('console', (m) => {
      // a media request's failure is reported above with its reason, not as the browser's line about the resource
      if (m.type() === 'error' && !isMedia(m.location()?.url || '')) errors.push(`console: ${m.text()}`.slice(0, 400))
    })
    page.on('pageerror', (e) => errors.push(`page: ${e.message}`.slice(0, 400)))
    // a fetch or a marks request keeps the page from being shot until it is answered
    const tracked = async (kind, body) => {
      inflight++
      lastActivity = Date.now()
      try {
        return await ask(kind, { state: i, ...body })
      } finally {
        inflight--
        lastActivity = Date.now()
      }
    }
    await page.exposeFunction('thimbleFetch', (query) => {
      fetches++
      return tracked('fetch', { query })
    })
    await page.exposeFunction('thimbleMarks', (refs) => tracked('marks', { refs }))
    await page.exposeFunction('thimbleNote', (kind, text) => {
      lastActivity = Date.now()
      if (kind === 'error') errors.push(String(text).slice(0, 400))
    })
    const tokens = readFileSync(new URL('../frontend/src/styles/tokens.css', import.meta.url), 'utf8')
    // served from an http address, as the browser serves thimble's page: a relative URL in the view (a <script src>
    // the frame's policy blocks) resolves and is refused as in the browser, where under about:blank it resolved to
    // nothing and failed silently, so a view the browser could not show passed its checks (live check L31)
    await page.route(CHECK_PAGE, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: `<!doctype html><html><head><style>${tokens}</style></head><body style="margin:0;background:var(--paper-0,#fbfaf7)"><iframe id="f" sandbox="allow-scripts" style="border:0;width:100%;height:100vh;display:block"></iframe></body></html>`,
      }),
    )
    await page.goto(CHECK_PAGE)
    await page.evaluate(
      ({ doc, place, names, fonts }) => {
        const f = document.getElementById('f')
        const css = getComputedStyle(document.documentElement)
        const vars = names.map((k) => [k, css.getPropertyValue(k).trim()]).filter(([, v]) => v).map(([k, v]) => `${k}:${v}`).join(';')
        const style = `<style>${fonts}:root{color-scheme:light;${vars}}</style>`
        const at = doc.search(/<head[^>]*>/i)
        const framed = at >= 0 ? doc.slice(0, doc.indexOf('>', at) + 1) + style + doc.slice(doc.indexOf('>', at) + 1) : style + doc
        window.__ready = false
        window.__height = null
        window.__refs = new Set()
        window.__acting = false
        window.__selfLabels = []
        window.__on = []
        let marks = {}
        window.__marks = marks
        let state = { on: [], filter: null, all: [], palette: [] }
        const post = (msg) => f.contentWindow.postMessage(msg, '*')
        const labels = () => post({ type: 'thimble:labels', marks, on: state.on, filter: state.filter, all: state.all, palette: state.palette })
        const ask = async (refs) => {
          const got = await window.thimbleMarks(refs)
          marks = { ...marks, ...(got.marks || {}) }
          window.__marks = marks
          state = { on: got.on || [], filter: got.filter || null, all: got.all || [], palette: got.palette || [] }
          window.__on = state.on.map((l) => String(l.id || ''))
          labels()
        }
        addEventListener('message', async (e) => {
          if (e.source !== f.contentWindow) return
          const d = e.data || {}
          if (d.type === 'thimble:anchors') {
            const fresh = (d.refs || []).map(String).filter((r) => !window.__refs.has(r))
            for (const r of fresh) window.__refs.add(r)
            if (fresh.length) await ask(fresh)
          } else if (d.type === 'thimble:ready') {
            window.__ready = true
            post({ type: 'thimble:key', key: 'check' })
            await ask([])
            post({ type: 'thimble:open', open: place })
          } else if (d.type === 'thimble:fetch') {
            const msg = await window.thimbleFetch(d.query)
            post({ type: 'thimble:result', id: d.id, data: msg.data, error: msg.error })
          } else if (d.type === 'thimble:error') {
            window.thimbleNote('error', d.message)
          } else if (d.type === 'thimble:size') {
            window.__height = d.height
          } else if (d.type === 'thimble:labelRefused') {
            window.__selfLabels.push(String(d.op || ''))
          } else if (d.type === 'thimble:labelCall') {
            if (window.__acting) post({ type: 'thimble:labelDone', id: d.id })
            else {
              window.__selfLabels.push(String(d.op || ''))
              post({ type: 'thimble:labelDone', id: d.id, error: 'thimble changes labels only while the analyst clicks or types in the view' })
            }
          }
        })
        f.srcdoc = framed
      },
      { doc, place: state.open || {}, names: VIEW_TOKENS, fonts: faces() },
    )
    const t0 = Date.now()
    while (!(await page.evaluate(() => window.__ready)) && Date.now() - t0 < READY_MS) await page.waitForTimeout(50)
    const ready = await page.evaluate(() => window.__ready)
    if (!ready) errors.push('the page never said it was ready (the bridge did not load, or a script stopped it)')
    // until the page has been quiet for QUIET_MS, at least `min` ms after `from`, or HARD_MS after `from` with no
    // request unanswered, or ANSWER_MS after it
    const settle = async (from, min) => {
      lastActivity = Math.max(lastActivity, from)
      for (;;) {
        await page.waitForTimeout(100)
        const t = Date.now() - from
        if (inflight === 0 && Date.now() - lastActivity > QUIET_MS && t > min) break
        if ((t >= HARD_MS && inflight === 0) || t >= ANSWER_MS) break
      }
    }
    await settle(Date.now(), MIN_MS)
    const el = await page.$('#f')
    const frame = await el.contentFrame()
    const actions = []
    for (const want of ready ? state.actions || [] : []) {
      const how = await frame.evaluate(findControl, { want: String(want), sel: CONTROLS }).catch(() => '')
      const target = frame.locator('[data-thimble-act]').first()
      // a label call while the action is clicked and the page settles is the analyst's
      await page.evaluate(() => (window.__acting = true))
      try {
        if (how === 'select') await target.selectOption(await target.getAttribute('data-thimble-act'), { timeout: 3000 })
        else if (how === 'click') await target.click({ timeout: 3000 }).catch(() => target.evaluate((x) => x.click()))
      } catch {
        // a control that would not take the action counts as not found
      }
      actions.push({ control: String(want), found: !!how })
      if (how) await settle(Date.now(), QUIET_MS)
      await page.evaluate(() => (window.__acting = false))
    }
    // every choice of the kit's controls in turn: what the page reports while it draws one is that choice's error
    const choices = []
    if (ready && state.sweep) {
      const list = await frame
        .evaluate(() => (window.thimble && typeof window.thimble.__choices === 'function' ? window.thimble.__choices().map((c) => [String(c.control), String(c.choice)]) : []))
        .catch(() => [])
      // each control's first choice (Off, None) once more after the others, as the analyst comes back to it from a
      // label or a field
      const firsts = []
      for (const [control, choice] of list) if (!firsts.some(([c]) => c === control)) firsts.push([control, choice])
      for (const [control, choice, again] of [...list.slice(0, SWEEP_MAX), ...firsts.map(([c, ch]) => [c, ch, true])]) {
        const before = errors.length
        await page.evaluate(() => (window.__acting = true))
        const threw = await frame
          .evaluate(([a, b]) => {
            const c = window.thimble.__choices().find((x) => String(x.control) === a && String(x.choice) === b)
            if (!c) return ''
            try {
              c.go()
              return ''
            } catch (e) {
              return String((e && e.message) || e)
            }
          }, [control, choice])
          .catch((e) => String((e && e.message) || e))
        const from = Date.now()
        lastActivity = Math.max(lastActivity, from)
        for (;;) {
          await page.waitForTimeout(50)
          if (inflight === 0 && Date.now() - lastActivity > SWEEP_QUIET_MS && Date.now() - from > SWEEP_QUIET_MS) break
          if (Date.now() - from >= SWEEP_MS) break
        }
        await page.evaluate(() => (window.__acting = false))
        const got = errors.splice(before)
        if (threw) got.unshift(`page: ${threw}`.slice(0, 400))
        choices.push({ control, choice: again ? `${choice} (after the others)` : choice, errors: got })
      }
    }
    // a request the page sent after the last wait ended, such as the next page of data it loads, is waited for before
    // it counts as unanswered
    const until = Date.now() + ANSWER_MS
    while (inflight > 0 && Date.now() < until) await settle(Date.now(), 0)
    if (inflight > 0) errors.push(`${inflight} request(s) still unanswered after ${ANSWER_MS / 1000} s`)
    const fonts = await frame
      .evaluate(async () => {
        await document.fonts.ready
        await document.fonts.load('13px "Hanken Grotesk"').catch(() => [])
        return document.fonts.check('13px "Hanken Grotesk"')
      })
      .catch(() => false)
    if (state.out) await el.screenshot({ path: state.out })
    const height = await page.evaluate(() => window.__height)
    const refs = await page.evaluate(() => [...window.__refs])
    const marks = await page.evaluate(() => window.__marks || {})
    const count = (sel) => frame.evaluate((s) => document.querySelectorAll(s).length, sel).catch(() => 0)
    const shown = await frame.evaluate(shownCounts, { marks, record: RECORD_REF.source }).catch(() => null)
    const layout = await frame.evaluate(layoutCounts).catch(() => null)
    const controls = await frame.evaluate(controlList, { sel: CONTROLS, max: CONTROLS_MAX }).catch(() => [])
    const on = await page.evaluate(() => window.__on || []).catch(() => [])
    const labelControls = await frame.evaluate((ids) => [...document.querySelectorAll('[data-label]')].filter((e) => ids.includes(e.getAttribute('data-label'))).length, on).catch(() => 0)
    const painted = ready ? await paintedMarks(page, el, frame, marks).catch((e) => ({ error: plain(e) })) : null
    return {
      ok: ready && errors.length === 0,
      errors,
      fetches,
      height,
      refs: refs.length,
      records: refs.filter((r) => RECORD_REF.test(r)).length,
      units: refs.filter((r) => /^view:[^/]+\/.+/.test(r)).length,
      marked: await count('[data-thimble-label]'),
      hidden: await count('[data-thimble-drop]'),
      shown,
      layout,
      controls,
      label_controls: labelControls,
      painted,
      actions,
      ...(state.sweep ? { choices } : {}),
      fonts,
      self_labels: await page.evaluate(() => window.__selfLabels),
    }
  } finally {
    await page.close()
  }
}

// Whether the label marks in the frame's view can be seen, from pictures of the frame with the bridge's label styles on
// and off: {due, checked, seen, unseen} (markTargets, paintedCount), null when no shown record is marked. It runs last,
// since it may scroll the page.
async function paintedMarks(page, el, frame, marks) {
  if (!Object.values(marks).some((m) => m && typeof m.bar === 'string' && m.bar)) return null
  const want = { marks, record: RECORD_REF.source, bar: BAR, max: PAINT_MAX }
  let got = await frame.evaluate(markTargets, { ...want, scroll: true })
  if (got.retry) {
    await page.waitForTimeout(300)
    got = await frame.evaluate(markTargets, { ...want, scroll: false })
  }
  if (!got.due) return null
  if (!got.list.length) return { due: got.due, checked: 0, seen: 0, unseen: [] }
  const on = (await el.screenshot()).toString('base64')
  const styles = (off) =>
    frame.evaluate((x) => {
      for (const s of document.querySelectorAll('style[data-thimble="labels"]')) s.disabled = x
    }, off)
  await styles(true)
  let off
  try {
    off = (await el.screenshot()).toString('base64')
  } finally {
    await styles(false)
  }
  return { due: got.due, ...(await page.evaluate(paintedCount, { on, off, targets: got.list, tol: PAINT_TOL })) }
}

async function main() {
  const opt = args(process.argv.slice(2))
  const doc = readFileSync(opt.frame, 'utf8')
  const states = JSON.parse(readFileSync(opt.states, 'utf8') || '[]')
  // the system's Chrome, Edge or Chromium when thimble's config picks it (backend/app/userconf.py)
  const executablePath = process.env.THIMBLE_BROWSER_PATH || undefined
  const browser = await chromium.launch({ executablePath })
  const out = new Array(states.length)
  let next = 0
  const worker = async () => {
    while (next < states.length) {
      const i = next++
      try {
        out[i] = await shootState(browser, opt, doc, states[i], i)
      } catch (e) {
        out[i] = { ok: false, errors: [plain(e)] }
      }
    }
  }
  try {
    await Promise.all(Array.from({ length: Math.min(PAGES_AT_ONCE, states.length) }, worker))
  } finally {
    await browser.close()
  }
  say({ done: true, states: out })
}

main().catch((e) => {
  say({ done: true, states: [], error: plain(e) })
  process.exit(1)
})
