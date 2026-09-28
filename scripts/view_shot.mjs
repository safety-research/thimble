#!/usr/bin/env node
// A view's page loaded headless, for a view's checks, its review and the screenshot tool (backend/app/views.py
// shoot_states), and a video's film for the frames the writer looks at (backend/app/video.py), in the headless Chromium
// of the frontend's Playwright (frontend/node_modules, which scripts/install.sh installs).
//   node scripts/view_shot.mjs --frame <html> --states <json> [--viewport <w>x<h>] [--media <url>]
// --states names a JSON list of states, [{out, open, labels, ids}], each shot on a fresh page of one browser: `open` is
// the place the page is sent once the frame is ready, `out` the PNG written, `labels` the names of the labels that are
// on and `ids` their ids.
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
// browser. A state is shot when its page has been quiet (no fetch or marks request in flight) for QUIET_MS after
// `open`, or HARD_MS has passed. One line ends the run: {"done": true, "states": [{ok, errors, fetches, height, refs,
// records, units, marked, hidden, controls, pills, fonts}]}: `refs` the distinct data-anchor refs the page reported, `records`
// those naming a record (`<path>#L<n>`), `units` those naming one of the view's units (`view:<slug>/<key>`), `marked`
// the elements carrying a label's mark in the shot, `hidden` those the bridge hid or dimmed for the filter, `controls`
// the page's own controls whose short text names a label that is on (labelControls), `pills` the chips and buttons it
// drew as rounded pills of its own rather than with thimble's parts (ownPills), and `fonts` whether Hanken Grotesk was
// loaded in the frame.
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
const MEDIA_CHUNK = 4 * 1024 * 1024 // bytes of one Range answer
const MEDIA_WHOLE_MAX = 32 * 1024 * 1024 // a request without Range (an <img>) gets a file up to this size whole
// A control's text longer than this is a row or a card that shows a label's mark, not a control for the label.
const CONTROL_TEXT_MAX = 60
const CONTROLS = 'button, select, option, input, label, summary, [role=button], [role=checkbox], [role=switch], [role=menuitemcheckbox], [role=option], [role=tab]'

// The page's own controls whose short text names one of `names`, such as a toggle, a checkbox or a menu item for a
// label; a <label> counts only when it labels a form control. A control inside an element whose data-label names one of
// `ids`, a label thimble sent, is thimble's: it calls thimble.setLabel or setLabelColour. Runs in the frame.
function labelControls({ names, ids, sel, max }) {
  const want = names.map((n) => String(n).toLowerCase()).filter(Boolean)
  if (!want.length) return 0
  const bound = (el) => {
    const at = el.closest('[data-label]')
    return !!at && String(at.getAttribute('data-label')).split(/\s+/).some((id) => id && ids.includes(id))
  }
  let n = 0
  for (const el of document.querySelectorAll(sel)) {
    if (el.tagName === 'LABEL' && !el.control) continue
    if (bound(el)) continue
    const own = [el.getAttribute('aria-label'), el.getAttribute('title'), el.tagName === 'INPUT' ? el.value : el.textContent]
    const text = own.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim().toLowerCase()
    if (text && text.length <= max && want.some((w) => text.includes(w))) n++
  }
  return n
}
// thimble's parts that draw as boxes (backend/app/viewer_kit.css): the chips, buttons and controls in the app's style.
const KIT = '.chip, .btn, .seg, .field'
// A pill's text longer than this is a card or a row, not a chip or a button.
const PILL_TEXT_MAX = 40

// The elements with a short text drawn as a rounded pill, a filled or edged box whose corners are at least half its
// height, outside thimble's parts: a chip or a button the page styled itself. Runs in the frame.
function ownPills({ kit, max }) {
  let n = 0
  for (const el of document.body ? document.body.querySelectorAll('*') : []) {
    if (el instanceof SVGElement || el.closest(kit)) continue
    const r = el.getBoundingClientRect()
    if (r.height < 12 || r.height > 36 || r.width < r.height * 1.2) continue
    const text = (el.textContent || '').trim()
    if (!text || text.length > max) continue
    const cs = getComputedStyle(el)
    if ((parseFloat(cs.borderTopLeftRadius) || 0) < r.height / 2 - 1) continue
    const filled = !/^(transparent|rgba\(0, 0, 0, 0\))$/.test(cs.backgroundColor)
    const edged = parseFloat(cs.borderTopWidth) > 0 && cs.borderTopStyle !== 'none'
    if (filled || edged) n++
  }
  return n
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
  const page = await browser.newPage({ viewport: opt.viewport })
  try {
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
        let state = { on: [], filter: null }
        const post = (msg) => f.contentWindow.postMessage(msg, '*')
        const labels = () => post({ type: 'thimble:labels', marks, on: state.on, filter: state.filter })
        const ask = async (refs) => {
          const got = await window.thimbleMarks(refs)
          marks = { ...marks, ...(got.marks || {}) }
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
    const opened = Date.now()
    lastActivity = opened
    while (Date.now() - t0 < HARD_MS) {
      await page.waitForTimeout(100)
      if (inflight === 0 && Date.now() - lastActivity > QUIET_MS && Date.now() - opened > MIN_MS) break
    }
    if (inflight > 0) errors.push(`${inflight} request(s) still unanswered after ${HARD_MS / 1000} s`)
    const el = await page.$('#f')
    const frame = await el.contentFrame()
    const fonts = await frame
      .evaluate(async () => {
        await document.fonts.ready
        await document.fonts.load('13px "Hanken Grotesk"').catch(() => [])
        return document.fonts.check('13px "Hanken Grotesk"')
      })
      .catch(() => false)
    await el.screenshot({ path: state.out })
    const height = await page.evaluate(() => window.__height)
    const refs = await page.evaluate(() => [...window.__refs])
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
      controls: await frame.evaluate(labelControls, { names: state.labels || [], ids: state.ids || [], sel: CONTROLS, max: CONTROL_TEXT_MAX }).catch(() => 0),
      pills: await frame.evaluate(ownPills, { kit: KIT, max: PILL_TEXT_MAX }).catch(() => 0),
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
  const browser = await chromium.launch()
  const out = []
  try {
    for (let i = 0; i < states.length; i++) {
      try {
        out.push(await shootState(browser, opt, doc, states[i], i))
      } catch (e) {
        out.push({ ok: false, errors: [String(e && e.message ? e.message : e)] })
      }
    }
  } finally {
    await browser.close()
  }
  say({ done: true, states: out })
}

main().catch((e) => {
  say({ done: true, states: [], error: String(e && e.message ? e.message : e) })
  process.exit(1)
})
