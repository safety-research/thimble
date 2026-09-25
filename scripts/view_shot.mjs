#!/usr/bin/env node
// A view's page loaded headless, for a view's checks and the screenshot tool (backend/app/views.py shoot), in the
// headless Chromium of the frontend's Playwright (frontend/node_modules, which scripts/install.sh installs).
//   node scripts/view_shot.mjs --frame <html> --open <json> --out <png> [--viewport <w>x<h>] [--media <url>]
//                              [--marks <json> [--after <png>]]
// The page plays the part frontend/src/files/ViewerFrame.tsx plays in the browser: it puts the frame document (the
// view page with the bridge, views.frame_document) in a sandboxed iframe, sends `open` with the place in the --open
// file once the frame is ready, and answers each `fetch` by asking the server over stdin and stdout, one JSON line each
// way: {"fetch": <id>, "query": ...} out, {"id": <id>, "data": ...} or {"id": <id>, "error": "..."} back. A request to
// the --media URL (the view's media route, thimble.mediaUrl) asks the server which file it names the same way,
// {"media": <id>, "path": ...} out, {"id": <id>, "file", "type", "size"} or {"id": <id>, "error"} back, and is answered
// from that file here, a Range request with the bytes it asks for (at most MEDIA_CHUNK). Every other request the page
// makes is refused, so a view that reaches for the network fails here as it would in the browser.
// --marks names a file of label marks, {ref: {bar, names, spans}} as ViewerFrame sends them (labels.ts viewMarks):
// each `anchors` report is answered with them as `labels`, so the shot shows the labels drawn over the page's records,
// in the label palette ViewerFrame gives the page (--label-1..8 and --label-none, read from the app's tokens.css).
// With --after, the page is then sent an empty `labels`, as when every label is turned off, and shot again there.
// When the page has been quiet (no fetch in flight) for QUIET_MS after `open`, or HARD_MS has passed, the frame is
// shot to --out and one line ends the run: {"done": true, "ok", "errors": [...], "fetches", "height", "refs",
// "records"}, `refs` the distinct data-anchor refs the page reported and `records` those naming a record
// (`<path>#L<n>`), which the labels are drawn over; plus, with --marks, "anchors" (the refs the page reported) and
// "marked" (its elements carrying a mark in the shot, then after the empty `labels` when there is --after: [before,
// after]).
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

function args(argv) {
  const out = { frame: null, open: null, out: null, media: null, marks: null, after: null, viewport: { width: 1100, height: 760 } }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => argv[++i]
    if (a === '--frame') out.frame = next()
    else if (a === '--open') out.open = next()
    else if (a === '--out') out.out = next()
    else if (a === '--media') out.media = next()
    else if (a === '--marks') out.marks = next()
    else if (a === '--after') out.after = next()
    else if (a === '--viewport') {
      const m = /^(\d+)x(\d+)$/.exec(next() || '')
      if (m) out.viewport = { width: Number(m[1]), height: Number(m[2]) }
    }
  }
  if (!out.frame || !out.out) throw new Error('usage: view_shot.mjs --frame <html> --open <json> --out <png> [--viewport WxH]')
  return out
}

const say = (obj) => process.stdout.write(JSON.stringify(obj) + '\n')

/** The label palette as a style element for the frame document, from the first value of each --label-* token in the
 * app's tokens.css, as ViewerFrame's viewStyle puts the theme's tokens into the page. */
function labelStyle() {
  const css = readFileSync(new URL('../frontend/src/styles/tokens.css', import.meta.url), 'utf8')
  const seen = new Map()
  for (const m of css.matchAll(/(--label-(?:\d|none))\s*:\s*([^;]+);/g)) if (!seen.has(m[1])) seen.set(m[1], m[2].trim())
  return `<style>:root{${[...seen].map(([k, v]) => `${k}:${v}`).join(';')}}</style>`
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

async function main() {
  const opt = args(process.argv.slice(2))
  const page0 = readFileSync(opt.frame, 'utf8')
  const frame = opt.marks ? page0.replace(/<head[^>]*>/i, (h) => h + labelStyle()) : page0
  const place = opt.open ? JSON.parse(readFileSync(opt.open, 'utf8') || '{}') : {}
  const marks = opt.marks ? JSON.parse(readFileSync(opt.marks, 'utf8') || '{}') : null
  const errors = []
  const answers = new Map()
  let seq = 0
  let mediaSeq = 0
  let inflight = 0
  let lastActivity = Date.now()
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

  const browser = await chromium.launch()
  try {
    const page = await browser.newPage({ viewport: opt.viewport })
    const isMedia = (url) => !!opt.media && (url === opt.media || url.startsWith(opt.media + '?'))
    await page.route('**/*', async (route) => {
      const req = route.request()
      if (!isMedia(req.url())) return route.abort()
      const path = new URL(req.url()).searchParams.get('path') || ''
      const id = `m${++mediaSeq}`
      const msg = await new Promise((resolve) => {
        answers.set(id, resolve)
        say({ media: id, path })
      })
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
    await page.exposeFunction('thimbleFetch', (query) => {
      const id = ++seq
      inflight++
      lastActivity = Date.now()
      return new Promise((resolve) => {
        answers.set(id, (msg) => {
          inflight--
          lastActivity = Date.now()
          resolve(msg)
        })
        say({ fetch: id, query })
      })
    })
    await page.exposeFunction('thimbleNote', (kind, text) => {
      lastActivity = Date.now()
      if (kind === 'error') errors.push(String(text).slice(0, 400))
    })
    await page.setContent(
      `<!doctype html><html><body style="margin:0;background:#fbfaf7"><iframe id="f" sandbox="allow-scripts" style="border:0;width:100%;height:100vh;display:block"></iframe></body></html>`,
    )
    await page.evaluate(
      ({ doc, place, marks }) => {
        const f = document.getElementById('f')
        window.__ready = false
        window.__height = null
        window.__anchors = 0
        window.__refs = new Set()
        addEventListener('message', async (e) => {
          if (e.source !== f.contentWindow) return
          const d = e.data || {}
          if (d.type === 'thimble:anchors') {
            window.__anchors += (d.refs || []).length
            for (const r of d.refs || []) window.__refs.add(String(r))
            if (marks) f.contentWindow.postMessage({ type: 'thimble:labels', marks }, '*')
          } else if (d.type === 'thimble:ready') {
            window.__ready = true
            f.contentWindow.postMessage({ type: 'thimble:open', open: place }, '*')
          } else if (d.type === 'thimble:fetch') {
            const msg = await window.thimbleFetch(d.query)
            f.contentWindow.postMessage({ type: 'thimble:result', id: d.id, data: msg.data, error: msg.error }, '*')
          } else if (d.type === 'thimble:error') {
            window.thimbleNote('error', d.message)
          } else if (d.type === 'thimble:size') {
            window.__height = d.height
          }
        })
        f.srcdoc = doc
      },
      { doc: frame, place, marks },
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
    if (inflight > 0) errors.push(`${inflight} fetch(es) still unanswered after ${HARD_MS / 1000} s`)
    const el = await page.$('#f')
    await el.screenshot({ path: opt.out })
    const height = await page.evaluate(() => window.__height)
    // the page's data-anchor refs, and those that name a record (`<path>#L<n>`), the ones labels are drawn over
    const refs = await page.evaluate(() => [...window.__refs])
    const extra = { refs: refs.length, records: refs.filter((r) => /^.+#L[1-9]\d*$/.test(r)).length }
    if (marks) {
      const frameDoc = await el.contentFrame()
      const count = () => frameDoc.evaluate(() => document.querySelectorAll('[data-thimble-label]').length)
      extra.anchors = await page.evaluate(() => window.__anchors)
      extra.marked = await count()
      if (opt.after) {
        await page.evaluate(() => document.getElementById('f').contentWindow.postMessage({ type: 'thimble:labels', marks: {} }, '*'))
        await page.waitForTimeout(200)
        await el.screenshot({ path: opt.after })
        extra.marked = [extra.marked, await count()]
      }
    }
    say({ done: true, ok: ready && errors.length === 0, errors, fetches: seq, height, ...extra })
  } finally {
    await browser.close()
  }
}

main().catch((e) => {
  say({ done: true, ok: false, errors: [String(e && e.message ? e.message : e)] })
  process.exit(1)
})
