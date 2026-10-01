#!/usr/bin/env node
// A view's page loaded headless, for a view's checks, its review and the screenshot tool (backend/app/views.py
// shoot_states), and a video's film for the frames the writer looks at (backend/app/video.py), in the headless Chromium
// of the frontend's Playwright (frontend/node_modules, which scripts/install.sh installs).
//   node scripts/view_shot.mjs --frame <html> --states <json> [--viewport <w>x<h>] [--media <url>]
// --states names a JSON list of states, [{out, open, actions?, viewport?}], each loaded on a fresh page of one browser,
// PAGES_AT_ONCE at a time:
// `open` is the place the page is sent once the frame is ready, `actions` the controls clicked in turn once it is quiet,
// each named by the text it shows (findControl), `viewport` {width, height} the state's own size in place of
// --viewport, and `out` the PNG written (none without it).
// The page plays the part frontend/src/files/ViewerFrame.tsx plays in the browser: it puts the frame document (the view
// page with the bridge, views.frame_document) in a sandboxed iframe with the theme's tokens and the app's two faces, and
// asks the server over stdin and stdout, one JSON line each way, for what the page needs:
//   {"fetch": id, "state": i, "query": ...}   answered {"id", "data"} or {"id", "error"}: reader.records for the state
//   {"marks": id, "state": i, "refs": [...]}  answered {"id", "marks", "on", "filter"}: the marks of those refs and the
//                                             labels that are on in the state, sent to the page as `labels`
//   {"media": id, "path": ...}                answered {"id", "file", "type", "size"} or {"id", "error"}: the file a
//                                             request to the --media URL (thimble.mediaUrl) names, served from here,
//                                             a Range request with the bytes it asks for (at most MEDIA_CHUNK)
// Every other request the page makes is refused, so a view that reaches for the network fails here as it would in the
// browser. A state is measured when its page has been quiet (no fetch or marks request in flight) for QUIET_MS after
// `open`, or HARD_MS has passed, and again after each action. One line ends the run: {"done": true, "states": [{ok,
// errors, fetches, height, refs, records, units, marked, hidden, shown, layout, controls, actions, fonts}]}: `refs` the
// distinct data-anchor refs the page reported, `records` those naming a record (`<path>#L<n>`), `units` those naming
// one of the view's units (`view:<slug>/<key>`), `marked` the elements carrying a label's mark, `hidden` those the
// bridge hid or dimmed for the filter, `shown` what is on screen at the end (shownCounts), `layout` how its text fits
// (layoutCounts), `controls` the controls it shows (controlList), `actions` each action with whether its control was
// found, and `fonts` whether Hanken Grotesk was loaded in the frame.
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { createInterface } from 'node:readline'

const require = createRequire(new URL('../frontend/package.json', import.meta.url))
const { chromium } = require('playwright')

const QUIET_MS = 900
const MIN_MS = 1200
const HARD_MS = 25_000
const READY_MS = 10_000
const PAGES_AT_ONCE = 3 // states loaded side by side, each on its own page
const MEDIA_CHUNK = 4 * 1024 * 1024 // bytes of one Range answer
const MEDIA_WHOLE_MAX = 32 * 1024 * 1024 // a request without Range (an <img>) gets a file up to this size whole

// An error's message without the boxed notice Playwright adds to a failed launch, which names an install command: the
// server hands these messages to models.
const plain = (e) => String(e && e.message ? e.message : e).split('\n').filter((l) => !/^[╔║╚]/.test(l)).join('\n')

// What the page shows at the end, counted once per ref on the outermost visible element that carries it (not a canvas,
// which takes no mark, and not one the bridge hid or dimmed for the filter): `records` and `units` anchored, `due` the
// refs whose `marks` entry has a bar, `drawn` those of them whose element carries the bridge's mark, and `unkept` the
// records shown that the filter does not keep, other than those inside a unit it keeps. Runs in the frame.
function shownCounts({ marks }) {
  const RECORD = /^.+#L[1-9]\d*$/
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
    seen.set(ref, { drawn: (was && was.drawn) || top.hasAttribute('data-thimble-label'), held: (!was || was.held) && held })
  }
  const out = { records: 0, units: 0, due: 0, drawn: 0, unkept: 0 }
  for (const [ref, { drawn, held }] of seen) {
    const record = RECORD.test(ref)
    if (record) out.records++
    else out.units++
    const m = marks[ref]
    if (m && typeof m.bar === 'string' && m.bar) {
      out.due++
      if (drawn) out.drawn++
    }
    if (record && !held && !(m && m.keep)) out.unkept++
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
    if (el.scrollWidth <= el.clientWidth + 2 || !visible(el)) continue
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
  '--ink-rgb', '--accent-hover', '--text-accent', '--text-on-accent', '--text-on-inverse', '--text-placeholder', '--surface-hover', '--surface-selected', '--surface-inverse', '--raised-bg', '--raised-ring', '--track-bg', '--chip-edge', '--chip-bg', '--chip-edge-hover',
  '--chip-bg-hover', '--text-xs', '--text-ui-sm', '--text-sm', '--text-lg', '--text-mono', '--text-mono-sm', '--h-chip', '--h-control', '--control-sm', '--h-row', '--radius-chip', '--radius-seg', '--radius-ui', '--radius-card', '--transition-color',
  '--accent-soft', '--border-hairline', '--border-strong', '--bg-panel', '--status-positive', '--status-negative', '--status-warning',
  '--viz-1', '--viz-2', '--viz-3', '--viz-4', '--viz-5', '--viz-6', '--viz-7', '--viz-ink-1', '--viz-ink-2', '--viz-ink-3', '--viz-ink-4',
  '--label-1', '--label-2', '--label-3', '--label-4', '--label-5', '--label-6', '--label-7', '--label-8', '--label-9', '--label-10', '--label-11', '--label-12', '--label-none',
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
    await page.setContent(
      `<!doctype html><html><head><style>${tokens}</style></head><body style="margin:0;background:var(--paper-0,#fbfaf7)"><iframe id="f" sandbox="allow-scripts" style="border:0;width:100%;height:100vh;display:block"></iframe></body></html>`,
    )
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
        let marks = {}
        window.__marks = marks
        let state = { on: [], filter: null }
        const post = (msg) => f.contentWindow.postMessage(msg, '*')
        const labels = () => post({ type: 'thimble:labels', marks, on: state.on, filter: state.filter })
        const ask = async (refs) => {
          const got = await window.thimbleMarks(refs)
          marks = { ...marks, ...(got.marks || {}) }
          window.__marks = marks
          state = { on: got.on || [], filter: got.filter || null }
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
            await ask([])
            post({ type: 'thimble:open', open: place })
          } else if (d.type === 'thimble:fetch') {
            const msg = await window.thimbleFetch(d.query)
            post({ type: 'thimble:result', id: d.id, data: msg.data, error: msg.error })
          } else if (d.type === 'thimble:error') {
            window.thimbleNote('error', d.message)
          } else if (d.type === 'thimble:size') {
            window.__height = d.height
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
    // until the page has been quiet for QUIET_MS, at least `min` ms after `from`, or HARD_MS after `from`
    const settle = async (from, min) => {
      lastActivity = Math.max(lastActivity, from)
      while (Date.now() - from < HARD_MS) {
        await page.waitForTimeout(100)
        if (inflight === 0 && Date.now() - lastActivity > QUIET_MS && Date.now() - from > min) break
      }
    }
    await settle(Date.now(), MIN_MS)
    const el = await page.$('#f')
    const frame = await el.contentFrame()
    const actions = []
    for (const want of ready ? state.actions || [] : []) {
      const how = await frame.evaluate(findControl, { want: String(want), sel: CONTROLS }).catch(() => '')
      const target = frame.locator('[data-thimble-act]').first()
      try {
        if (how === 'select') await target.selectOption(await target.getAttribute('data-thimble-act'), { timeout: 3000 })
        else if (how === 'click') await target.click({ timeout: 3000 }).catch(() => target.evaluate((x) => x.click()))
      } catch {
        // a control that would not take the action counts as not found
      }
      actions.push({ control: String(want), found: !!how })
      if (how) await settle(Date.now(), QUIET_MS)
    }
    if (inflight > 0) errors.push(`${inflight} request(s) still unanswered after ${HARD_MS / 1000} s`)
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
    return {
      ok: ready && errors.length === 0,
      errors,
      fetches,
      height,
      refs: refs.length,
      records: refs.filter((r) => /^.+#L[1-9]\d*$/.test(r)).length,
      units: refs.filter((r) => /^view:[^/]+\/.+/.test(r)).length,
      marked: await count('[data-thimble-label]'),
      hidden: await count('[data-thimble-drop]'),
      shown: await frame.evaluate(shownCounts, { marks }).catch(() => null),
      layout: await frame.evaluate(layoutCounts).catch(() => null),
      controls: await frame.evaluate(controlList, { sel: CONTROLS, max: CONTROLS_MAX }).catch(() => []),
      actions,
      fonts,
    }
  } finally {
    await page.close()
  }
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
