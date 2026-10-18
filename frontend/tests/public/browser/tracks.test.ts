// The reader's strip (src/files/Tracks.tsx ReaderTracks) and its loupe (src/files/Loupe.tsx) with the app's stylesheets
// in headless Chromium. Resting on the strip opens the loupe beside it after LOUPE_REST_MS, not before: a line per
// record, its number, its cells in its own colors and the start of its text. A press on the strip sends the thumb there
// and scrubs the reader, and a click on a find's tick goes to it.
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, test } from 'vitest'
import type { Browser, Page } from 'playwright'
import { bundle, cleanup, launch, ORIGIN, src } from './page.ts'

let browser: Browser
let page: Page
/** the bundle's folder, which a page at another pixel ratio loads from too */
let dir = ''

/** A page of the bundle at a device pixel ratio, the strip mounted over a file of `total` records (`long`, each with
 * a time and a text far longer than the loupe). */
async function open(dpr: number, total = 10_000, long = false): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1000, height: 640 }, deviceScaleFactor: dpr })
  await page.route('**/*', (route) => {
    const p = new URL(route.request().url()).pathname
    if (p === '/')
      return route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: '<!doctype html><html lang="en"><head><meta charset="utf-8"><link rel="stylesheet" href="/bundle.css"></head><body style="margin:0"><div id="root"></div><div id="report"></div><script src="/bundle.js"></script></body></html>',
      })
    const file = path.join(dir, p)
    if (existsSync(file))
      return route.fulfill({
        status: 200,
        contentType: p.endsWith('.css') ? 'text/css' : 'text/javascript',
        body: readFileSync(file),
      })
    return route.fulfill({ status: 404, body: '' })
  })
  await page.goto(`${ORIGIN}/?total=${total}${long ? '&long=1' : ''}`)
  await page.waitForSelector('.track-frame-over')
  await page.waitForTimeout(250)
  return page
}

beforeAll(async () => {
  const script = await bundle(
    'tracks',
    [
      `import '${src('styles/index.css')}'`,
      `import { createRoot } from 'react-dom/client'`,
      `import { flushSync } from 'react-dom'`,
      `import { useRef } from 'react'`,
      `import { PlaceFeed, ReaderTracks } from '${src('files/Tracks.tsx')}'`,
      `import { PageRuler } from '${src('files/Ruler.tsx')}'`,
      `import { setAccent, setPaper } from '${src('lib/theme.ts')}'`,
      `const w = window as any`,
      `w.__theme = { setAccent, setPaper }`,
      `const TOTAL = Number(new URLSearchParams(location.search).get('total') || 10000)`,
      `const LONG = new URLSearchParams(location.search).get('long') === '1'`,
      `Object.assign(w, { __seeks: [], __asked: [], __scrolled: [], __lines: [], __marks: [] })`,
      `const root = createRoot(document.getElementById('root')!)`,
      // two values over 100 bins: the first two thirds mostly the first value, the last third the second
      `const counts = [Array.from({ length: 100 }, (_, i) => (i < 66 ? 5 : 0)), Array.from({ length: 100 }, (_, i) => (i < 66 ? 1 : 6))]`,
      `const feed = new PlaceFeed()`,
      `w.__feed = feed`,
      `const markers = [{ id: 'find', name: '"county"', total: TOTAL, ticks: [{ from: Math.round(TOTAL * 0.4), to: Math.round(TOTAL * 0.42), colour: 'var(--text-primary)' }] }]`,
      // every 7th record of the first value (blue), every 11th of the second (orange), read after a moment
      `const records = (from, to) => { w.__asked.push([from, to]); const out = []; for (let l = from; l <= to; l++) out.push({ line: l, lanes: [l % 7 === 0 ? 'var(--label-1)' : l % 11 === 0 ? 'var(--label-2)' : null], meta: LONG ? ['20:' + String(l % 60).padStart(2, '0') + ':07', 'AgentRelent'] : ['AgentRelent'], text: 'message ' + l + ' about the county' + (LONG ? ' and the gale'.repeat(20) : '') }); return new Promise((r) => setTimeout(() => r(out), 30)) }`,
      // the reader in the middle of the file, showing 25 records of it, as it publishes its place
      `const place = (top) => ({ top, height: 25 / TOTAL, scroll: top * TOTAL * 28, h: 600, content: TOTAL * 28, start: false, end: false })`,
      `root.render(<div style={{ height: 600, display: 'flex', justifyContent: 'flex-end' }}><ReaderTracks total={TOTAL} feed={feed} paint={{ kind: 'counts', counts, colors: ['var(--label-1)', 'var(--label-2)'], off: [false, false] }} markers={markers} onSeek={(f, held) => w.__seeks.push([f, held])} onScrollBy={(px) => { w.__scrolled.push(px); const p = feed.place; flushSync(() => feed.set(place(Math.max(0, Math.min(1, p.top + px / (TOTAL * 28)))))); return px }} onMark={(c, t) => w.__marks.push([c, t.from])} onLine={(l) => { w.__lines.push(l); flushSync(() => feed.set(place(Math.max(0, (l - 13) / TOTAL)))) }} records={records} /></div>)`,
      `w.__render = (top) => { flushSync(() => feed.set(place(top))); return new Promise((r) => setTimeout(r, 250)) }`,
      // the reader's place moving by a hair, as it does while records load or a browser rounds its scroll
      `w.__nudge = (k) => flushSync(() => feed.set(place(0.5 + k * 3e-5)))`,
      `w.__render(0.5)`,
      // the report: a page of \`screens\` screens of 560 px beside its ruler, a lane of marks over passages
      `const reportRoot = createRoot(document.getElementById('report')!)`,
      `function Report({ screens }) { const box = useRef(null); const H = 560 * screens; const ticks = [0.1, 0.104, 0.108, 0.3, 0.6].map((f) => ({ from: Math.round(f * H) + 1, to: Math.round(f * H) + 40, colour: 'var(--label-3)', value: 'x' })); const passages = Array.from({ length: Math.floor(H / 80) }, (_, i) => ({ top: i * 80, bottom: i * 80 + 70, text: (i % 10 ? 'Passage ' : 'Section ') + i + ' of the report, which goes on for a while', heading: i % 10 === 0 })); return <div style={{ position: 'fixed', inset: 0, display: 'flex', background: 'var(--bg-app)' }}><div ref={box} className="wu-page" style={{ flex: 1, overflow: 'auto', height: 560 }}><div style={{ height: H }} /></div><PageRuler scroller={box} columns={[{ id: 'check', name: 'Alternative explanations', total: H, ticks }]} onJump={(f) => w.__marks.push(['jump', f])} onMark={(c, t) => w.__marks.push([c, t.from])} tipOf={(col) => col.name} passages={passages} /></div> }`,
      `w.__report = (screens) => { flushSync(() => reportRoot.render(<Report key={screens} screens={screens} />)); return new Promise((r) => setTimeout(r, 300)) }`,
    ],
    {
      loader: { '.css': 'css', '.woff2': 'empty', '.woff': 'empty' },
      conditions: ['style'],
    },
  )
  dir = path.dirname(script)
  browser = await launch()
  page = await open(1)
})

afterAll(async () => {
  await browser?.close()
  cleanup()
})

/** The boxes of the strip's parts and of the loupe, and the thumb's look. */
const layout = (pg: Page = page) =>
  pg.evaluate(() => {
    const box = (sel: string) => {
      const el = document.querySelector(sel)
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }
    }
    const frame = document.querySelector('.track-frame-over')!
    const loupe = document.querySelector('.loupe')!
    const bracket = document.querySelector('.loupe-bracket')!
    return {
      tracks: box('.tracks')!,
      over: box('.track-over')!,
      frame: box('.track-frame-over')!,
      loupe: box('.loupe-box'),
      bracket: box('.loupe-bracket'),
      open: loupe.hasAttribute('data-open'),
      frozen: loupe.hasAttribute('data-frozen'),
      bracketOpen: bracket.hasAttribute('data-open'),
      second: document.querySelectorAll('.track-zoom, .track-lens, .track-link, .reader-ruler-zoom, .reader-ruler-lanes').length,
      frameWidth: parseFloat(getComputedStyle(frame).borderTopWidth),
      frameRadius: parseFloat(getComputedStyle(frame).borderTopLeftRadius),
      frameFill: getComputedStyle(frame).backgroundColor,
      chip: parseFloat(getComputedStyle(document.body).getPropertyValue('--radius-chip')),
      tips: document.querySelectorAll('.tip').length,
      rulerTip: document.querySelector('.reader-ruler-tip')?.textContent ?? null,
      rulerTipOne: document.querySelector('.reader-ruler-tip')?.classList.contains('tip-one') ?? false,
      rulerTipH: (document.querySelector('.reader-ruler-tip') as HTMLElement | null)?.offsetHeight ?? 0,
      rows: [...document.querySelectorAll('.loupe[data-open] .loupe-row')].map((r) => ({
        n: r.querySelector('.loupe-n')!.textContent ?? '',
        text: r.querySelector('.loupe-t')!.textContent ?? '',
        cells: [...r.querySelectorAll('.loupe-cell')].map((i) => (i as HTMLElement).style.background),
        seen: r.classList.contains('seen'),
        at: r.classList.contains('at'),
        top: r.getBoundingClientRect().top,
        height: r.getBoundingClientRect().height,
      })),
    }
  })

const near = (a: number, b: number, tol = 1) => Math.abs(a - b) <= tol

/** The pointer off the strip and the loupe, the loupe closed, the reader back in the middle. */
async function reset(pg: Page = page) {
  await pg.mouse.move(10, 10)
  await pg.evaluate(() => (window as any).__render(0.5))
  await pg.waitForTimeout(100)
}

const num = (n: string) => Number(n.replace(/,/g, ''))

test('resting on the strip opens the loupe beside it, not before: a line per record, its number, its cells in its own colors, the start of its text', async () => {
  await reset()
  await page.evaluate(() => ((window as any).__asked = []))
  const over = (await page.locator('.track-over').boundingBox())!
  const y = over.y + over.height * 0.3
  await page.mouse.move(over.x + over.width / 2, y)
  await page.waitForTimeout(120)
  assert.equal((await layout()).open, false, 'not before the pointer has rested')
  await page.waitForTimeout(300)
  const g = await layout()
  assert.equal(g.open, true)
  // beside the strip, its middle at the pointer
  assert.ok(g.loupe!.right <= g.over.left && g.loupe!.right > g.over.left - 16, JSON.stringify([g.loupe, g.over]))
  assert.ok(near((g.loupe!.top + g.loupe!.bottom) / 2, y, 2), `the loupe's middle ${(g.loupe!.top + g.loupe!.bottom) / 2}, the pointer ${y}`)
  assert.ok(g.loupe!.width >= 200 && g.loupe!.width <= 320, `as wide as the room leaves, 200 to 320 px: ${g.loupe!.width}`)
  // the bracket beside the strip, on the loupe's side, over the records it shows
  assert.equal(g.bracketOpen, true)
  assert.ok(g.bracket!.right <= g.over.left && g.bracket!.right >= g.over.left - 2 && g.bracket!.left > g.loupe!.right - 1, JSON.stringify([g.bracket, g.over, g.loupe]))
  assert.ok(near((g.bracket!.top + g.bracket!.bottom) / 2, y, 2), JSON.stringify([g.bracket, y]))
  // 17 lines of 16 px, in order, the pointer's record in the middle one and darker
  assert.equal(g.rows.length, 17)
  assert.ok(g.rows.every((r) => r.height === 16))
  const ns = g.rows.map((r) => num(r.n))
  assert.ok(ns.every((n, i) => !i || n === ns[i - 1] + 1), `numbered in order: ${ns}`)
  assert.equal(g.rows.findIndex((r) => r.at), 8)
  assert.ok(Math.abs(ns[8] - 3001) <= 2, `the pointer's record ${ns[8]}`)
  assert.ok(g.rows.every((r) => !r.seen), 'none of them on screen')
  // the records around it asked for, and once read each line says who and the start of its text, its cell in its own
  // color (every 7th record blue, every 11th orange), the find's cell empty
  const asked = await page.evaluate(() => (window as any).__asked as [number, number][])
  assert.ok(ns.every((n) => asked.some(([a, b]) => a <= n && b >= n)), `asked ${JSON.stringify(asked)}`)
  await page.waitForTimeout(150)
  const h = await layout()
  for (const r of h.rows) {
    const n = num(r.n)
    assert.equal(r.text, `AgentRelentmessage ${n} about the county`)
    assert.equal(r.cells.length, 2)
    assert.equal(r.cells[0], '')
    assert.equal(r.cells[1], n % 7 === 0 ? 'var(--label-1)' : n % 11 === 0 ? 'var(--label-2)' : '')
  }
  assert.ok(h.rows.some((r) => r.cells[1] === 'var(--label-1)'))
  assert.equal(h.tips, 0, 'no tooltip beside the loupe')
})

test('a press elsewhere on the strip sends the thumb there and scrubs the reader; a click on a find tick goes to it', async () => {
  await reset()
  await page.evaluate(() => ((window as any).__seeks = []))
  const over = (await page.locator('.track-over').boundingBox())!
  await page.mouse.move(over.x + over.width - 5, over.y + over.height * 0.8)
  await page.mouse.down()
  await page.mouse.move(over.x + over.width - 5, over.y + over.height * 0.85, { steps: 4 })
  await page.mouse.up()
  const seeks = await page.evaluate(() => (window as any).__seeks as [number, boolean][])
  assert.ok(seeks.length >= 2 && seeks[0][1] === true && seeks[seeks.length - 1][1] === false, JSON.stringify(seeks))
  assert.ok(seeks[seeks.length - 1][0] > seeks[0][0])
  // the find's tick over 40% to 42%, in its lane at the strip's left
  await page.evaluate(() => ((window as any).__marks = []))
  await page.mouse.click(over.x + 6, over.y + over.height * 0.41)
  assert.deepEqual(await page.evaluate(() => (window as any).__marks), [['find', 4000]])
})
