// The tracks' motion in a real browser, in Chromium and, where Playwright's WebKit starts, in WebKit: Files' reader
// (src/files/Reader.tsx and its two tracks, src/files/Tracks.tsx) over a file of 15,000 records answered in the page,
// in its Table and Transcript modes, and the view kit's strip (backend/app/viewer_colour.js) beside a list of 3,000
// records. Each is sampled after every painted frame during a steady drag of the overview's frame and a steady wheel
// scroll. In the frames where the pointer moved (or the list scrolled) the frame and the lens move too, never standing
// still to jump after (a step more than twice their share of the move and a pixel), the reader's records follow the
// drag rather than a page at a time, and a frame that draws only the tracks takes under 16 ms. Each run logs its
// numbers: the frames that moved, the largest step, and the frames' times. A click a pixel or two off a lone record
// that Color by colors snaps to it: the reader goes there and chooses it, in Files and in the kit.
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { afterAll, beforeAll, test } from 'vitest'
import { chromium, webkit, type Browser, type BrowserType, type Page } from 'playwright'
import { bundle, cleanup, ORIGIN, src } from './page.ts'

const MIME: Record<string, string> = { '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff' }
let dir = ''

beforeAll(async () => {
  const script = await bundle(
    'tracks-motion',
    [
      `import '${src('styles/index.css')}'`,
      `import { createRoot } from 'react-dom/client'`,
      `import { Reader } from '${src('files/Reader.tsx')}'`,
      `const w = window as any`,
      `const TOTAL = Number(new URLSearchParams(location.search).get('total') || 15000)`,
      `const DELAY = Number(new URLSearchParams(location.search).get('delay') || 20)`,
      `const MODE = new URLSearchParams(location.search).get('mode') || 'table'`,
      `localStorage.setItem('thimble:ws:viewOf:events.jsonl', JSON.stringify(MODE))`,
      // with ?lone=N every record is said by "plain" but record N, said by "orange", which Color by colors alone
      `const LONE = Number(new URLSearchParams(location.search).get('lone') || 0)`,
      `const who = (i) => (LONE ? (i === LONE ? 'orange' : 'plain') : 'Agent' + (i % 4))`,
      `const said = (i) => 'message ' + i + ' ' + 'lorem ipsum dolor sit amet '.repeat(1 + (i * 7) % 5)`,
      `const rec = (i) => MODE === 'transcript' ? { line: i, record: { time: '2026-06-18T20:' + String(i % 60).padStart(2, '0') + ':00Z', speaker: who(i), text: said(i) }, blocks: [{ kind: 'text', text: said(i) }], meta: {} } : { line: i, record: { event_id: 'save:dse~Page' + (i % 997) + '@' + i, event_type: i % 5 ? 'save' : 'request', wiki: 'dse', page: 'Page' + (i % 997), page_key: 'dse~Page' + (i % 997), time: '2026-06-18T20:' + String(i % 60).padStart(2, '0') + ':00Z' }, blocks: [], meta: {} }`,
      `const hint = MODE === 'transcript' ? { transcript: { format: 'messages', score: 0.95, keys: { speaker: 'speaker', text: 'text', time: 'time' } } } : {}`,
      `const page = (a, b) => { const out = []; for (let i = Math.max(1, a); i <= Math.min(TOTAL, b); i++) out.push(rec(i)); return { path: 'events.jsonl', kind: MODE === 'transcript' ? 'text' : 'events', total_lines: TOTAL, start: Math.max(1, a), records: out, ...hint } }`,
      `w.__asks = []`,
      `const answer = (u) => {`,
      `  const p = u.pathname, s = u.searchParams`,
      `  if (p.endsWith('/source/around')) { const l = +s.get('line'); w.__asks.push(['around', l, performance.now()]); return page(l - +s.get('before'), l + +s.get('after')) }`,
      `  if (p.endsWith('/source/lines')) return { path: 'events.jsonl', total_lines: TOTAL, estimated: false, indexed: 1 }`,
      `  if (p.endsWith('/source')) { const a = +s.get('start'); w.__asks.push(['page', a, performance.now()]); return page(a, a + +s.get('count') - 1) }`,
      `  if (p.endsWith('/source/keys')) return { path: 'events.jsonl', total: TOTAL, bins: LONE ? 1000 : 0, partial: false, bytes: [], keys: LONE ? [{ key: 'speaker', values: [{ value: 'plain', n: TOTAL - 1 }, { value: 'orange', n: 1 }], more: { values: 0, n: 0 }, none: 0, at: Array.from({ length: 1000 }, (_, b) => (b === Math.floor(((LONE - 1) / TOTAL) * 1000) ? 1 : 0)) }] : [] }`,
      `  return null`,
      `}`,
      `w.fetch = async (url, init) => {`,
      `  const u = new URL(String(url), location.origin)`,
      `  const got = answer(u)`,
      `  await new Promise((r) => setTimeout(r, DELAY))`,
      `  if (got == null) return new Response(JSON.stringify({ detail: 'not here' }), { status: 404, headers: { 'content-type': 'application/json' } })`,
      `  return new Response(JSON.stringify(got), { status: 200, headers: { 'content-type': 'application/json' } })`,
      `}`,
      `const labels = { all: [], on: [], focus: null, setFocus() {}, byId: new Map(), presence: new Map(), toggle() {}, setClasses() {}, setColour() {}, save: async () => ({}), remove: async () => {} }`,
      `createRoot(document.getElementById('root')!).render(<div style={{ height: 640, display: 'flex' }}><div className="files-main"><Reader workspace="ws" path="events.jsonl" kind="events" labels={labels} lead={null} /></div></div>)`,
    ],
    {
      loader: { '.css': 'css', '.woff2': 'file', '.woff': 'file', '.json': 'json' },
      conditions: ['style'],
      assetNames: '[name]-[hash]',
      publicPath: '/',
      define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env.BASE_URL': '"/"' },
    },
  )
  dir = path.dirname(script)
})

afterAll(() => cleanup())

async function open(engine: BrowserType, query: string): Promise<{ browser: Browser; page: Page }> {
  const browser = await engine.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 }, deviceScaleFactor: 2 })
  page.on('pageerror', (e) => console.warn('page error:', e.message))
  await page.route('**/*', (route) => {
    const p = new URL(route.request().url()).pathname
    if (p === '/') return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><html lang="en"><head><meta charset="utf-8"><link rel="stylesheet" href="/bundle.css"></head><body style="margin:0"><div id="root"></div><script src="/bundle.js"></script></body></html>' })
    const file = path.join(dir, p)
    if (existsSync(file)) return route.fulfill({ status: 200, contentType: MIME[path.extname(file)] ?? 'application/octet-stream', body: readFileSync(file) })
    return route.fulfill({ status: 404, body: '' })
  })
  await page.goto(`${ORIGIN}/${query}`)
  await page.waitForSelector('.track-lens', { timeout: 20000 })
  await page.waitForTimeout(400)
  return { browser, page }
}

/** Start sampling the tracks once per painted frame: after each frame's rendering, the frame's and the lens's tops, the
 * top line's ends, the first zoomed record's top, the body's scrollTop, and the pointer's y as last seen. */
const startSampling = (page: Page) =>
  page.evaluate(() => {
    const w = window as any
    w.__samples = []
    w.__moves = []
    w.__sampling = true
    addEventListener('pointermove', (e) => w.__moves.push([performance.now(), e.clientY]), { capture: true })
    const ch = new MessageChannel()
    let t0 = 0
    ch.port1.onmessage = () => {
      const q = (s: string) => document.querySelector(s)?.getBoundingClientRect()
      const line = document.querySelector('.track-link line[data-edge="top"]')
      const rec = document.querySelector('.track-zoom-faded .track-rec')
      w.__samples.push({
        t: t0,
        work: performance.now() - t0,
        frame: q('.track-frame-over')?.top ?? null,
        lens: q('.track-lens')?.top ?? null,
        y1: line ? Number(line.getAttribute('y1')) : null,
        y2: line ? Number(line.getAttribute('y2')) : null,
        rec: rec ? rec.getBoundingClientRect().top : null,
        recLine: rec ? Number((rec as HTMLElement).dataset.line) : null,
        st: (document.querySelector('.reader-body') as HTMLElement).scrollTop,
        top: Number(document.querySelector('.reader-body .reader-card')?.getAttribute('data-line') ?? 0),
      })
    }
    const tick = (t: number) => {
      if (!w.__sampling) return
      t0 = performance.now()
      ch.port2.postMessage(0)
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })

const stopSampling = (page: Page) =>
  page.evaluate(() => {
    const w = window as any
    w.__sampling = false
    return { samples: w.__samples as any[], moves: w.__moves as [number, number][] }
  })

/** Per frame: how far the pointer, the frame, the lens and the content moved. */
function motion(samples: any[], moves: [number, number][]) {
  let j = 0
  let y = moves.length ? moves[0][1] : 0
  const rows = samples.map((s) => {
    while (j < moves.length && moves[j][0] <= s.t) y = moves[j++][1]
    return { ...s, y }
  })
  return rows.slice(1).map((r, i) => {
    const a = rows[i]
    return { dy: r.y - a.y, frame: r.frame - a.frame, lens: r.lens - a.lens, st: r.st - a.st, rec: r.rec != null && a.rec != null && r.recLine === a.recLine ? r.rec - a.rec : null, top: r.top !== a.top, gap: r.t - a.t, work: r.work }
  })
}

function report(name: string, rows: ReturnType<typeof motion>, key: 'lens' | 'frame' | 'rec', by: 'dy' | 'st') {
  const driven = rows.filter((r) => Math.abs(r[by]) > 1e-3)
  const vals = driven.map((r) => r[key]).filter((v): v is number => v != null)
  const moved = vals.filter((v) => Math.abs(v) > 1e-3).length
  // the ratio of this part's motion to what drives it, over the whole run: the step each frame should take
  const total = driven.reduce((t, r) => t + Math.abs(r[by]), 0)
  const went = driven.reduce((t, r) => t + Math.abs((r[key] as number) ?? 0), 0)
  const ratio = total ? went / total : 0
  // a stall then a jump: a driven frame that did not move, then within 10 frames one that moved more than twice its share and a pixel
  let stalls = 0
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]
    if (Math.abs(r[by]) <= 1e-3 || r[key] == null || Math.abs(r[key] as number) > 1e-3) continue
    for (let k = i + 1; k < Math.min(rows.length, i + 10); k++) {
      const v = rows[k][key]
      if (v != null && Math.abs(v) > 2 * ratio * Math.abs(rows[k][by]) + 1) {
        stalls++
        break
      }
    }
  }
  const max = Math.max(0, ...vals.map(Math.abs))
  return { name: `${name}.${key}`, frames: driven.length, moved: vals.length ? moved / vals.length : 1, max, ratio, stalls }
}

const fmt = (r: ReturnType<typeof report>) => `${r.name}: driven frames ${r.frames}, moved ${(100 * r.moved).toFixed(0)}%, max step ${r.max.toFixed(2)}px, mean ratio ${r.ratio.toFixed(3)}, stall→jump ${r.stalls}`

function timing(rows: ReturnType<typeof motion>) {
  const gaps = rows.map((r) => r.gap).sort((a, b) => a - b)
  const work = rows.map((r) => r.work).sort((a, b) => a - b)
  const p = (xs: number[], q: number) => xs[Math.min(xs.length - 1, Math.floor(q * xs.length))]
  return `frame gap p50 ${p(gaps, 0.5).toFixed(1)} p95 ${p(gaps, 0.95).toFixed(1)} max ${gaps[gaps.length - 1].toFixed(1)} ms; work p50 ${p(work, 0.5).toFixed(1)} p95 ${p(work, 0.95).toFixed(1)} max ${work[work.length - 1].toFixed(1)} ms`
}

/** The engines: Chromium, and WebKit where Playwright's WebKit is installed and starts (CI installs Chromium alone). */
const ENGINES: [string, BrowserType][] = [
  ['chromium', chromium],
  ['webkit', webkit],
]
const runs = new Map<string, boolean>()
beforeAll(async () => {
  for (const [name, engine] of ENGINES) {
    const b = await engine.launch({ headless: true }).catch(() => null)
    runs.set(name, !!b)
    if (!b) console.log(`${name} does not start here, so its runs of the tracks' motion are skipped`)
    await b?.close()
  }
})

const pct = (x: number) => `${(100 * x).toFixed(0)}%`
/** The frames' times: the work from a frame's animation callbacks to its rendering done, at a quantile. */
const workAt = (rows: { work: number }[], q: number) => {
  const xs = rows.map((r) => r.work).sort((a, b) => a - b)
  return xs.length ? xs[Math.min(xs.length - 1, Math.floor(q * xs.length))] : 0
}
/** The two parts moved in nearly every driven frame and never stood still to jump after. */
function smooth(r: ReturnType<typeof report>, at: string) {
  assert.ok(r.frames >= 12, `${at}: only ${r.frames} driven frames`)
  assert.ok(r.moved >= 0.9, `${at}: ${r.name} moved in ${pct(r.moved)} of the driven frames`)
  assert.equal(r.stalls, 0, `${at}: ${r.name} stood still and then jumped ${r.stalls} times`)
}

for (const [name, engine] of ENGINES) {
  for (const mode of ['table', 'transcript']) {
    test(`${name}, Files' ${mode}: a steady drag of the overview's frame moves the frame, the lens and the records every frame`, async (ctx) => {
      if (!runs.get(name)) return ctx.skip()
      const { browser, page } = await open(engine, `?mode=${mode}`)
      const over = (await page.locator('.track-over').boundingBox())!
      const frame = (await page.locator('.track-frame-over').boundingBox())!
      const x = over.x + over.width / 2
      let y = frame.y + frame.height / 2
      await page.mouse.move(x, y)
      await page.mouse.down()
      await startSampling(page)
      for (let i = 0; i < 160; i++) {
        y += 1
        await page.mouse.move(x, y)
        await page.waitForTimeout(8)
      }
      const { samples, moves } = await stopSampling(page)
      await page.mouse.up()
      const rows = motion(samples, moves)
      const driven = rows.filter((r) => Math.abs(r.dy) > 1e-3)
      const followed = driven.filter((r) => r.top).length / driven.length
      const still = rows.filter((r) => !r.top)
      const f = report('drag', rows, 'frame', 'dy')
      const l = report('drag', rows, 'lens', 'dy')
      console.log(`\n${name} Files ${mode}, drag of the frame:\n  ${fmt(f)}\n  ${fmt(l)}\n  the records changed in ${pct(followed)} of the driven frames\n  ${timing(rows)}; frames that drew only the tracks: work p90 ${workAt(still, 0.9).toFixed(1)} ms`)
      smooth(f, `${name} ${mode}`)
      smooth(l, `${name} ${mode}`)
      assert.ok(followed >= 0.2, `the records changed in only ${pct(followed)} of the driven frames`)
      assert.ok(workAt(still, 0.9) < 16, `frames that drew only the tracks took ${workAt(still, 0.9)} ms at p90`)
      await browser.close()
    })
  }

  test(`${name}, Files: a steady wheel scroll moves the zoomed track's records every frame the reader scrolls`, async (ctx) => {
    if (!runs.get(name)) return ctx.skip()
    const { browser, page } = await open(engine, '?mode=table')
    const body = (await page.locator('.reader-body').boundingBox())!
    await page.mouse.move(body.x + body.width / 2, body.y + body.height / 2)
    await startSampling(page)
    for (let i = 0; i < 160; i++) {
      await page.mouse.wheel(0, 6)
      await page.waitForTimeout(8)
    }
    const { samples, moves } = await stopSampling(page)
    const rows = motion(samples, moves)
    const r = report('wheel', rows, 'rec', 'st')
    const l = report('wheel', rows, 'lens', 'st')
    console.log(`\n${name} Files, wheel:\n  ${fmt(r)}\n  ${fmt(l)}\n  ${timing(rows)}`)
    smooth(r, `${name} wheel`)
    smooth(l, `${name} wheel`)
    assert.ok(workAt(rows, 0.9) < 16, `frames took ${workAt(rows, 0.9)} ms at p90`)
    await browser.close()
  })
}

// ---------------------------------------------------------------- the view kit's strip
const APP = path.join(__dirname, '../../../../backend/app')
const kitRead = (name: string) => readFileSync(path.join(APP, name), 'utf8')
const kitInline = (js: string) => js.replace(/<\/script/g, '<\\/script')
const KIT = () => `<script>${kitInline(kitRead('viewer_bridge.js'))}</script><script>window.__thimbleLabelOrder = ${kitRead('label_order.json')}</script><script>${kitInline(kitRead('viewer_colour.js'))}</script><script>${kitInline(kitRead('viewer_range.js'))}</script><style>${kitRead('viewer_kit.css')}</style>`
const KIT_TOKENS =
  ':root{--label-1:#025ac3;--label-2:#d0750a;--label-3:#08632f;--label-none:#a09c93;--ink-rgb:27,26,24;--surface-card:#fffdf8;' +
  '--text-primary:#000;--text-secondary:#4a4844;--text-tertiary:#726f69;--accent:#5135ff;--radius-chip:4px;--radius-ui:6px;' +
  '--h-row:28px;--control-sm:28px;--h-control:24px;--h-chip:20px;--text-xs:12px;--text-ui-sm:12px;--text-mono-sm:11px;--border-subtle:rgba(27,26,24,0.12);' +
  '--border-hairline:rgba(27,26,24,0.08);--font-body:sans-serif;--font-mono:monospace}'
const KIT_VIEW = (n = 3000) => `<!doctype html><html><head><style>${KIT_TOKENS} body{margin:0;font:12px sans-serif;background:#fffdf8} .top{display:flex;align-items:center;gap:8px;padding:8px}
#list{height:520px;overflow:auto} .msg{box-sizing:border-box;height:30px;padding:6px 8px 0 12px}</style>${KIT()}</head><body>
<div class="top"><span id="colour"></span></div><div id="list"></div>
<script>
const rows = Array.from({ length: ${n} }, (_, i) => ({ kind: (i * 7) % 11 < 3 ? 'With links' : 'Text only', ref: 'm.jsonl#L' + (i + 1) }))
window.colour = thimble.colorBy({ mount: '#colour', fields: [{ name: 'kind', title: 'Kind', values: ['Text only', 'With links'] }], strip: '#list', onChange: draw })
function draw() {
  document.getElementById('list').innerHTML = rows.map((r) => '<div class="msg" data-anchor="' + r.ref + '"' + colour.attr(r) + '>message ' + r.ref.slice(9) + '</div>').join('')
}
draw()
</script></body></html>`

async function kitPage(engine: BrowserType) {
  const browser = await engine.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 900, height: 700 }, deviceScaleFactor: 2 })
  await page.setContent(KIT_VIEW())
  const frame = () => page.mainFrame()
  await page.waitForTimeout(300)
  await frame().waitForSelector('.thimble-colour-lens', { state: 'attached' })
  await page.waitForTimeout(300)
  return { browser, page, frame }
}

const kitSampling = (f: import('playwright').Frame) =>
  f.evaluate(() => {
    const w = window as any
    w.__samples = []
    w.__moves = []
    w.__sampling = true
    addEventListener('pointermove', (e) => w.__moves.push([performance.now(), e.clientY]), { capture: true })
    const ch = new MessageChannel()
    let t0 = 0
    ch.port1.onmessage = () => {
      const q = (s: string) => document.querySelector(s)?.getBoundingClientRect()
      w.__samples.push({ t: t0, work: performance.now() - t0, frame: q('.thimble-colour-whole .thimble-colour-thumb')?.top ?? null, lens: q('.thimble-colour-lens')?.top ?? null, rec: null, recLine: null, st: (document.getElementById('list') as HTMLElement).scrollTop, top: Math.floor((document.getElementById('list') as HTMLElement).scrollTop / 30) })
    }
    const tick = () => {
      if (!w.__sampling) return
      t0 = performance.now()
      ch.port2.postMessage(0)
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })

for (const [name, engine] of ENGINES) {
  test(`${name}, the kit's strip: a steady drag of the overview's frame moves the frame, the lens and the list every frame`, async (ctx) => {
    if (!runs.get(name)) return ctx.skip()
    const { browser, page, frame } = await kitPage(engine)
    const thumb = (await frame().locator('.thimble-colour-whole .thimble-colour-thumb').boundingBox())!
    const x = thumb.x + thumb.width / 2
    let y = thumb.y + thumb.height / 2
    await page.mouse.move(x, y)
    await page.mouse.down()
    await kitSampling(frame())
    for (let i = 0; i < 160; i++) {
      y += 1
      await page.mouse.move(x, y)
      await page.waitForTimeout(8)
    }
    const { samples, moves } = await frame().evaluate(() => {
      const w = window as any
      w.__sampling = false
      return { samples: w.__samples, moves: w.__moves }
    })
    await page.mouse.up()
    const rows = motion(samples, moves)
    const driven = rows.filter((r) => Math.abs(r.dy) > 1e-3)
    const followed = driven.filter((r) => Math.abs(r.st) > 0).length / driven.length
    const f = report('drag', rows, 'frame', 'dy')
    const l = report('drag', rows, 'lens', 'dy')
    console.log(`\n${name} kit, drag of the frame:\n  ${fmt(f)}\n  ${fmt(l)}\n  the list moved in ${pct(followed)} of the driven frames\n  ${timing(rows)}`)
    smooth(f, `${name} kit`)
    smooth(l, `${name} kit`)
    assert.ok(followed >= 0.9, `the list moved in only ${pct(followed)} of the driven frames`)
    assert.ok(workAt(rows, 0.9) < 16, `frames took ${workAt(rows, 0.9)} ms at p90`)
    await browser.close()
  })

  test(`${name}, the kit's strip: a steady wheel scroll moves the frame and the lens every frame the list scrolls`, async (ctx) => {
    if (!runs.get(name)) return ctx.skip()
    const { browser, page, frame } = await kitPage(engine)
    const list = (await frame().locator('#list').boundingBox())!
    await page.mouse.move(list.x + list.width / 2, list.y + list.height / 2)
    await kitSampling(frame())
    for (let i = 0; i < 160; i++) {
      await page.mouse.wheel(0, 6)
      await page.waitForTimeout(8)
    }
    const { samples, moves } = await frame().evaluate(() => {
      const w = window as any
      w.__sampling = false
      return { samples: w.__samples, moves: w.__moves }
    })
    const rows = motion(samples, moves)
    const f = report('wheel', rows, 'frame', 'st')
    const l = report('wheel', rows, 'lens', 'st')
    console.log(`\n${name} kit, wheel:\n  ${fmt(f)}\n  ${fmt(l)}\n  ${timing(rows)}`)
    smooth(f, `${name} kit wheel`)
    smooth(l, `${name} kit wheel`)
    assert.ok(workAt(rows, 0.9) < 16, `frames took ${workAt(rows, 0.9)} ms at p90`)
    await browser.close()
  })
}

// ---------------------------------------------------------------- a click snaps to a thin patch of color
/** The y, in the page, of the overview's middle device row in a color unlike the track's first row's, and how many rows
 * it spans: where the lone record is drawn. */
const lonePatch = (f: import('playwright').Frame, canvas: string) =>
  f.evaluate((sel) => {
    const cv = document.querySelector(sel) as HTMLCanvasElement
    const data = cv.getContext('2d')!.getImageData(cv.width - 2, 0, 1, cv.height).data
    const px = (y: number) => Array.from(data.slice(y * 4, y * 4 + 4)).join(',')
    const ground = px(Math.floor(cv.height / 4))
    const odd: number[] = []
    for (let y = 0; y < cv.height; y++) if (data[y * 4 + 3] > 0 && px(y) !== ground) odd.push(y)
    const r = cv.getBoundingClientRect()
    const dpr = window.devicePixelRatio || 1
    return odd.length ? { y: r.top + (odd[0] + odd[odd.length - 1] + 1) / 2 / dpr, rows: odd.length, x: r.right - 3 } : null
  }, canvas)

for (const [name, engine] of ENGINES) {
  test(`${name}, Files: a click two pixels off a lone colored record snaps to it, and the reader goes there and chooses it`, async (ctx) => {
    if (!runs.get(name)) return ctx.skip()
    const { browser, page } = await open(engine, '?mode=transcript&lone=9001')
    await page.waitForFunction(() => document.querySelector('.reader-colorbar') != null)
    await page.waitForTimeout(400)
    const patch = await lonePatch(page.mainFrame(), '.track-over canvas')
    assert.ok(patch, 'the overview draws the lone record in its color')
    for (const off of [2, -2]) {
      // away from it first
      await page.mouse.click(patch.x, patch.y - 200)
      await page.waitForTimeout(500)
      assert.equal(await page.locator('.reader-card[data-line="9001"]').count(), 0, 'the lone record is not in the reader before the click')
      await page.mouse.click(patch.x, patch.y + off)
      await page.waitForSelector('.reader-card.reader-target[data-line="9001"]', { timeout: 5000 })
      await page.waitForTimeout(300)
      const seen = await page.evaluate(() => {
        const body = document.querySelector('.reader-body')!.getBoundingClientRect()
        const card = document.querySelector('.reader-card[data-line="9001"]')!.getBoundingClientRect()
        return { ok: card.bottom > body.top + 8 && card.top < body.bottom - 8, card: [card.top, card.bottom], body: [body.top, body.bottom] }
      })
      assert.ok(seen.ok, `a click ${off}px off the record scrolls it into view: ${JSON.stringify(seen)}`)
    }
    await browser.close()
  })

  test(`${name}, the kit's strip: a click two pixels off a lone colored record snaps to it, and the list goes there and chooses it`, async (ctx) => {
    if (!runs.get(name)) return ctx.skip()
    const browser = await engine.launch({ headless: true })
    const page = await browser.newPage({ viewport: { width: 900, height: 700 }, deviceScaleFactor: 2 })
    // 200 records, so that one record has rows of the overview to itself
    await page.setContent(KIT_VIEW(200).replace("(i * 7) % 11 < 3 ? 'With links' : 'Text only'", "i === 120 ? 'With links' : 'Text only'"))
    await page.waitForSelector('.thimble-colour-lens', { state: 'attached' })
    await page.waitForTimeout(400)
    const patch = await lonePatch(page.mainFrame(), '.thimble-colour-whole canvas')
    assert.ok(patch, 'the overview draws the lone record in its color')
    for (const off of [2, -2]) {
      await page.evaluate(() => (document.getElementById('list')!.scrollTop = 0))
      await page.waitForTimeout(200)
      await page.mouse.click(patch.x, patch.y + off)
      await page.waitForTimeout(300)
      const got = await page.evaluate(() => {
        const list = document.getElementById('list')!.getBoundingClientRect()
        const el = document.querySelector('[data-anchor="m.jsonl#L121"]')!
        const r = el.getBoundingClientRect()
        return { seen: r.top >= list.top && r.bottom <= list.bottom, chosen: el.hasAttribute('data-thimble-snap') }
      })
      assert.ok(got.seen, `a click ${off}px off the record scrolls it into view`)
      assert.ok(got.chosen, 'and chooses it')
    }
    await browser.close()
  })
}

