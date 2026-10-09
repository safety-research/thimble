// The reader's strip (src/files/Tracks.tsx ReaderTracks), its loupe (src/files/Loupe.tsx) and the report's ruler
// (src/files/Ruler.tsx PageRuler) with the app's stylesheets in headless Chromium, light and dark.
//
// The strip is one track at every length: the find's lane and a lane of colors in the scrollbar's geometry, no second
// track, a thumb exactly as wide as the strip, its edges on whole device pixels at a pixel ratio of 1 and 2 once still;
// each pixel row of a lane is one color and the find's matches are ticks in the ink. Resting on the strip opens the loupe
// beside it after LOUPE_REST_MS, not before, with a bracket beside the strip over the stretch it shows, the records there
// read and drawn in their own colors; it follows the pointer along the strip, and the thumb once the reader scrolls (the
// wheel, a drag of the thumb); moved into, it holds still, names the record under the pointer in thimble's tooltip, goes
// there on a click, and scrolls the reader on the wheel while it keeps its place; out of both, it closes. A touch press
// on the strip opens it, a drag scrubs and the release goes to the record under its line. A strip that tells every
// record apart opens no loupe and names the record under the pointer. A click on a find's tick goes to it, and a press
// on the strip sends the thumb there and scrubs. The report's ruler is the same one strip: a mark named on hover on a
// short page, the loupe on a long one, and a click on a mark, in the strip or the loupe, goes to it.
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

/** A page of the bundle at a device pixel ratio, the strip mounted over a file of `total` records. */
async function open(dpr: number, total = 10_000): Promise<Page> {
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
  await page.goto(`${ORIGIN}/?total=${total}`)
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
      `const w = window as any`,
      `const TOTAL = Number(new URLSearchParams(location.search).get('total') || 10000)`,
      `Object.assign(w, { __seeks: [], __asked: [], __scrolled: [], __lines: [], __marks: [] })`,
      `const root = createRoot(document.getElementById('root')!)`,
      // two values over 100 bins: the first two thirds mostly the first value, the last third the second
      `const counts = [Array.from({ length: 100 }, (_, i) => (i < 66 ? 5 : 0)), Array.from({ length: 100 }, (_, i) => (i < 66 ? 1 : 6))]`,
      `const feed = new PlaceFeed()`,
      `w.__feed = feed`,
      `const markers = [{ id: 'find', name: '"county"', total: TOTAL, ticks: [{ from: Math.round(TOTAL * 0.4), to: Math.round(TOTAL * 0.42), colour: 'var(--text-primary)' }] }]`,
      // every 7th record of the first value (blue), every 11th of the second (orange), read after a moment
      `const records = (from, to) => { w.__asked.push([from, to]); const out = []; for (let l = from; l <= to; l++) out.push({ line: l, lanes: [l % 7 === 0 ? 'var(--label-1)' : l % 11 === 0 ? 'var(--label-2)' : null], marks: [l % 7 === 0 ? 'kind: first' : null], who: 'AgentRelent', when: '2026-06-18 20:15', text: 'message ' + l + ' about the county' }); return new Promise((r) => setTimeout(() => r(out), 30)) }`,
      // the reader in the middle of the file, showing 25 records of it, as it publishes its place
      `const place = (top) => ({ top, height: 25 / TOTAL, scroll: top * TOTAL * 28, h: 600, content: TOTAL * 28, start: false, end: false })`,
      `root.render(<div style={{ height: 600, display: 'flex', justifyContent: 'flex-end' }}><ReaderTracks total={TOTAL} feed={feed} paint={{ kind: 'counts', counts, colors: ['var(--label-1)', 'var(--label-2)'], off: [false, false] }} markers={markers} onSeek={(f, held) => w.__seeks.push([f, held])} onScrollBy={(px) => { w.__scrolled.push(px); const p = feed.place; flushSync(() => feed.set(place(Math.max(0, Math.min(1, p.top + px / (TOTAL * 28)))))); return px }} onMark={(c, t) => w.__marks.push([c, t.from])} onLine={(l) => w.__lines.push(l)} records={records} /></div>)`,
      `w.__render = (top) => { flushSync(() => feed.set(place(top))); return new Promise((r) => setTimeout(r, 250)) }`,
      `w.__render(0.5)`,
      // the report: a page of \`screens\` screens of 560 px beside its ruler, a lane of marks over passages
      `const reportRoot = createRoot(document.getElementById('report')!)`,
      `function Report({ screens }) { const box = useRef(null); const H = 560 * screens; const ticks = [0.1, 0.104, 0.108, 0.3, 0.6].map((f) => ({ from: Math.round(f * H) + 1, to: Math.round(f * H) + 40, colour: 'var(--label-3)', value: 'x' })); return <div style={{ position: 'fixed', inset: 0, display: 'flex', background: 'var(--bg-app)' }}><div ref={box} className="wu-page" style={{ flex: 1, overflow: 'auto', height: 560 }}><div style={{ height: H }} /></div><PageRuler scroller={box} columns={[{ id: 'check', name: 'Alternative explanations', total: H, ticks }]} onJump={(f) => w.__marks.push(['jump', f])} onMark={(c, t) => w.__marks.push([c, t.from])} tipOf={(col) => col.name} /></div> }`,
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
      tip: document.querySelector('.loupe-tip')?.textContent ?? null,
      rulerTip: document.querySelector('.reader-ruler-tip')?.textContent ?? null,
    }
  })

const near = (a: number, b: number, tol = 1) => Math.abs(a - b) <= tol

/** The pointer off the strip and the loupe, the loupe closed, the reader back in the middle. */
async function reset(pg: Page = page) {
  await pg.mouse.move(10, 10)
  await pg.evaluate(() => (window as any).__render(0.5))
  await pg.waitForTimeout(100)
}

/** The pointer on the strip at a share of its height, resting there until the loupe opens. */
async function rest(f: number, pg: Page = page) {
  const over = (await pg.locator('.track-over').boundingBox())!
  await pg.mouse.move(over.x + over.width / 2, over.y + over.height * f)
  await pg.waitForTimeout(400)
  return over
}

for (const theme of ['light', 'dark']) {
  test(`one strip at the edge, its lanes in the scrollbar's geometry under a thumb exactly as wide, in the ${theme} theme`, async () => {
    await page.evaluate((t) => document.documentElement.setAttribute('data-paper', t === 'dark' ? 'dark' : 'warm'), theme)
    await reset()
    const g = await layout()
    assert.equal(g.second, 0, 'no second track, no lens')
    // the find's lane and one lane of colors: 2 × 7 px, a 2 px gap, 3 px either side
    assert.equal(g.over.width, 22)
    assert.ok(near(g.over.right, g.tracks.right - 6), JSON.stringify(g))
    assert.equal(g.frame.width, g.over.width)
    assert.equal(g.frame.left, g.over.left)
    assert.equal(g.frameWidth, 1)
    assert.ok(g.frameRadius > 0 && g.frameRadius <= g.chip, `the thumb's corners a chip's at most: ${g.frameRadius}`)
    assert.notEqual(g.frameFill, 'rgba(0, 0, 0, 0)', 'a light fill, so that the marks under it read')
    // the thumb in the middle of the file in the middle of the strip
    assert.ok(near((g.frame.top - g.over.top) / (g.over.height - g.frame.height), 0.5, 0.02), JSON.stringify(g))
    assert.equal(g.open, false)
  })
}

for (const dpr of [1, 2]) {
  test(`at a pixel ratio of ${dpr}, the thumb's edges stand on whole device pixels once still`, async () => {
    const pg = await open(dpr)
    for (const top of [0.5, 0.93, 0.0123]) {
      await pg.evaluate((t) => (window as any).__render(t), top)
      const g = await layout(pg)
      const on = (v: number) => Math.abs(v * dpr - Math.round(v * dpr)) < 1e-3
      for (const v of [g.frame.top, g.frame.bottom, g.frame.left, g.frame.right]) assert.ok(on(v), `${v} off the grid at ${top}: ${JSON.stringify(g.frame)}`)
    }
    await pg.close()
  })
}

test("each pixel row of the lane of colors is one color, and the find's matches leave ticks in the ink, no color", async () => {
  await page.evaluate(() => document.documentElement.setAttribute('data-paper', 'warm'))
  await reset()
  const rows = await page.evaluate(() => {
    const cv = document.querySelector('.track-over canvas') as HTMLCanvasElement
    const data = cv.getContext('2d')!.getImageData(0, 0, cv.width, cv.height).data
    const px = (x: number, y: number) => Array.from(data.slice((y * cv.width + x) * 4, (y * cv.width + x) * 4 + 4))
    const dpr = window.devicePixelRatio || 1
    // the lane of colors: 3 px in, the find's 7 px lane, a 2 px gap
    const x0 = Math.round(12 * dpr)
    const x1 = Math.round(19 * dpr)
    let mixed = 0
    const colours = new Set<string>()
    for (let y = 0; y < cv.height; y++) {
      const row = new Set<string>()
      for (let x = x0; x < x1; x++) row.add(px(x, y).join(','))
      if (row.size > 1) mixed++
      colours.add([...row][0])
    }
    // the find's tick over 40% to 42% of the file, in its lane
    return { mixed, colours: colours.size, tick: px(Math.round(6 * dpr), Math.round(cv.height * 0.41)) }
  })
  assert.equal(rows.mixed, 0, 'no row holds two colors side by side')
  assert.equal(rows.colours, 2, 'the first two thirds the first value, the last third the second')
  const [r, g, b, a] = rows.tick
  assert.ok(a > 0 && Math.max(r, g, b) - Math.min(r, g, b) < 12, `the find's tick has no color: ${rows.tick}`)
})

test('resting on the strip opens the loupe beside it, not before, with a bracket over the stretch it shows and its records read', async () => {
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
  // the bracket beside the strip, on the loupe's side, over the 72 records around the pointer's
  assert.equal(g.bracketOpen, true)
  assert.ok(g.bracket!.right <= g.over.left && g.bracket!.right >= g.over.left - 2 && g.bracket!.left > g.loupe!.right - 1, JSON.stringify([g.bracket, g.over, g.loupe]))
  assert.ok(near((g.bracket!.top + g.bracket!.bottom) / 2, y, 2), JSON.stringify([g.bracket, y]))
  // the records around line 3,000 asked for, and drawn in their own colors once read
  const asked = await page.evaluate(() => (window as any).__asked as [number, number][])
  const line = Math.floor(0.3 * 10_000)
  assert.ok(asked.some(([a, b]) => a <= line && b >= line), `asked ${JSON.stringify(asked)}`)
  await page.waitForTimeout(150)
  const full = await page.evaluate(() => {
    const cv = document.querySelector('.loupe canvas') as HTMLCanvasElement
    const probe = document.createElement('i')
    probe.style.color = 'var(--label-1)'
    document.body.appendChild(probe)
    const blue = getComputedStyle(probe).color.match(/\d+/g)!.slice(0, 3).map(Number)
    probe.remove()
    const d = cv.getContext('2d')!.getImageData(0, 0, cv.width, cv.height).data
    let n = 0
    for (let i = 0; i < d.length; i += 4) if (d[i + 3] === 255 && Math.abs(d[i] - blue[0]) < 3 && Math.abs(d[i + 1] - blue[1]) < 3 && Math.abs(d[i + 2] - blue[2]) < 3) n++
    return n
  })
  assert.ok(full > 0, 'the records read are drawn in their own color, at full strength')
})

test('the loupe follows the pointer along the strip, then the thumb once the reader scrolls on the wheel', async () => {
  await reset()
  const over = await rest(0.3)
  const a = await layout()
  await page.mouse.move(over.x + over.width / 2, over.y + over.height * 0.6, { steps: 5 })
  await page.waitForTimeout(50)
  const b = await layout()
  assert.ok(b.loupe!.top - a.loupe!.top > over.height * 0.25, `followed: ${a.loupe!.top} → ${b.loupe!.top}`)
  assert.ok(b.bracket!.top - a.bracket!.top > over.height * 0.25)
  // the wheel over the strip scrolls the reader: the loupe goes to the thumb, in the middle of the file
  await page.evaluate(() => ((window as any).__scrolled = []))
  for (let i = 0; i < 3; i++) await page.mouse.wheel(0, 100)
  await page.waitForTimeout(150)
  const c = await layout()
  const scrolled = await page.evaluate(() => ((window as any).__scrolled as number[]).reduce((s, x) => s + x, 0))
  assert.ok(scrolled >= 300, `the wheel scrolled the reader ${scrolled}`)
  assert.equal(c.open, true)
  assert.ok(near((c.loupe!.top + c.loupe!.bottom) / 2, (c.frame.top + c.frame.bottom) / 2, 2), `at the thumb: ${JSON.stringify([c.loupe, c.frame])}`)
  assert.ok(near((c.bracket!.top + c.bracket!.bottom) / 2, (c.frame.top + c.frame.bottom) / 2, 2))
  // out of the strip to the right, away from the loupe: it closes
  await page.mouse.move(over.x + over.width + 3, over.y + over.height * 0.6)
  await page.waitForTimeout(50)
  assert.equal((await layout()).open, false)
})

test('moved into, the loupe holds still: a record named in the tooltip, a click goes there, the wheel scrolls the reader', async () => {
  await reset()
  const over = await rest(0.3)
  const a = await layout()
  // straight left, out of the strip into the loupe
  const y = (a.loupe!.top + a.loupe!.bottom) / 2 + 20
  await page.mouse.move(over.x + over.width / 2, y)
  await page.mouse.move(over.x - 4, y, { steps: 2 })
  await page.mouse.move(a.loupe!.right - 12, y, { steps: 3 })
  await page.waitForTimeout(150)
  const b = await layout()
  assert.equal(b.frozen, true, 'held')
  assert.match(b.tip ?? '', /^Line [\d,]+/, `the tooltip: ${b.tip}`)
  assert.match(b.tip!, /AgentRelent · 2026-06-18 20:15/)
  assert.match(b.tip!, /message \d+ about the county/)
  const line = Number(b.tip!.match(/^Line ([\d,]+)/)![1].replace(/,/g, ''))
  // a click goes to that record
  await page.mouse.click(a.loupe!.right - 12, y)
  assert.deepEqual(await page.evaluate(() => (window as any).__lines), [line])
  // the wheel over it scrolls the reader, and the loupe keeps its place
  await page.evaluate(() => ((window as any).__scrolled = []))
  await page.mouse.wheel(0, 200)
  await page.waitForTimeout(100)
  const c = await layout()
  assert.ok((await page.evaluate(() => ((window as any).__scrolled as number[]).length)) > 0, 'the reader scrolled')
  assert.equal(c.loupe!.top, b.loupe!.top, 'the loupe kept its place')
  assert.equal(c.frozen, true)
  // back on the strip it follows the pointer again; out of both it closes
  await page.mouse.move(over.x + over.width / 2, over.y + over.height * 0.7, { steps: 4 })
  await page.waitForTimeout(50)
  const d = await layout()
  assert.equal(d.frozen, false)
  assert.ok(d.loupe!.top > c.loupe!.top + 50)
  await page.mouse.move(over.x + over.width / 2, over.y - 40)
  await page.waitForTimeout(50)
  assert.equal((await layout()).open, false)
  await page.evaluate(() => ((window as any).__lines = []))
})

test('a drag of the thumb shows the loupe at the thumb, and scrubs the reader', async () => {
  await reset()
  await page.evaluate(() => ((window as any).__seeks = []))
  const frame = (await page.locator('.track-frame-over').boundingBox())!
  const x = frame.x + frame.width / 2
  const y = frame.y + frame.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.waitForTimeout(30)
  const a = await layout()
  assert.equal(a.open, true, 'pressed, the loupe opens at the thumb')
  assert.ok(near((a.loupe!.top + a.loupe!.bottom) / 2, y, 2))
  await page.mouse.move(x, y + 60, { steps: 6 })
  await page.waitForTimeout(60)
  const b = await layout()
  assert.ok(near((b.loupe!.top + b.loupe!.bottom) / 2, (b.frame.top + b.frame.bottom) / 2, 2), `with the thumb: ${JSON.stringify([b.loupe, b.frame])}`)
  await page.mouse.up()
  const seeks = await page.evaluate(() => (window as any).__seeks as [number, boolean][])
  assert.ok(seeks.length >= 2 && seeks[0][1] === true && seeks[seeks.length - 1][1] === false, JSON.stringify(seeks))
  assert.ok(seeks[seeks.length - 1][0] > 0.5)
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

test('a touch press on the strip opens the loupe, a drag scrubs it, and the release goes to the record under its line', async () => {
  await reset()
  await page.evaluate(() => ((window as any).__lines = []))
  const over = (await page.locator('.track-over').boundingBox())!
  const x = over.x + over.width / 2
  const fire = (type: string, y: number) =>
    page.evaluate(
      ([type, x, y]) => document.querySelector('.track-over')!.dispatchEvent(new PointerEvent(type as string, { pointerType: 'touch', pointerId: 7, isPrimary: true, button: 0, buttons: type === 'pointerup' ? 0 : 1, clientX: x as number, clientY: y as number, bubbles: true, cancelable: true })),
      [type, x, y],
    )
  await fire('pointerdown', over.y + over.height * 0.2)
  await page.waitForTimeout(30)
  const a = await layout()
  assert.equal(a.open, true, 'open at once under the finger')
  await fire('pointermove', over.y + over.height * 0.25)
  await fire('pointermove', over.y + over.height * 0.3)
  await page.waitForTimeout(30)
  const b = await layout()
  assert.ok(b.loupe!.top > a.loupe!.top, 'it follows the finger')
  await fire('pointerup', over.y + over.height * 0.3)
  await page.waitForTimeout(30)
  const lines = await page.evaluate(() => (window as any).__lines as number[])
  assert.equal(lines.length, 1)
  assert.ok(Math.abs(lines[0] - 3000) <= 40, `went to ${lines[0]}`)
  assert.equal((await layout()).open, false, 'let go, it closes')
})

test('a strip that tells every record apart opens no loupe, and names the record under the pointer', async () => {
  const pg = await open(1, 150)
  const over = (await pg.locator('.track-over').boundingBox())!
  await pg.mouse.move(over.x + over.width / 2, over.y + over.height * 0.5)
  await pg.waitForTimeout(500)
  const g = await layout(pg)
  assert.equal(g.open, false)
  assert.match(g.rulerTip ?? '', /^Line 76\n/, `the record named: ${g.rulerTip}`)
  assert.match(g.rulerTip!, /message 76 about the county/)
  await pg.close()
})

/** The report's ruler as laid out. */
const ruler = (pg: Page) =>
  pg.evaluate(() => {
    const r = (sel: string) => document.querySelector(sel)?.getBoundingClientRect().toJSON() ?? null
    const loupes = [...document.querySelectorAll('.loupe')]
    return {
      bar: r('#report .reader-ruler-bar'),
      thumb: document.querySelector('#report .reader-ruler-thumb')?.className ?? null,
      second: document.querySelectorAll('#report .reader-ruler-lanes, #report .reader-ruler-zoom, #report .reader-ruler-band').length,
      open: loupes.some((l) => l.hasAttribute('data-open')),
      box: r('.loupe[data-open] .loupe-box'),
      tip: document.querySelector('.reader-ruler-tip')?.textContent ?? document.querySelector('.loupe-tip')?.textContent ?? null,
    }
  })

test("the report's ruler is one strip: on a short page a mark named on hover and gone to on a click, on a long page the loupe", async () => {
  const pg = await open(1)
  await pg.evaluate(() => (window as any).__report(4))
  const short = await ruler(pg)
  assert.equal(short.second, 0, 'no second rail, no lens')
  assert.equal(short.bar!.width, 13, 'one lane in the scrollbar')
  assert.match(short.thumb!, /finder/)
  const bar = short.bar!
  // the mark at 30% of a page of four screens
  const y = bar.top + bar.height * 0.3 + 2
  await pg.mouse.move(bar.left + bar.width / 2, y)
  await pg.waitForTimeout(450)
  const hover = await ruler(pg)
  assert.equal(hover.open, false, 'a page the strip shows large enough opens no loupe')
  assert.equal(hover.tip, 'Alternative explanations')
  await pg.evaluate(() => ((window as any).__marks = []))
  await pg.mouse.click(bar.left + bar.width / 2, y)
  assert.deepEqual((await pg.evaluate(() => (window as any).__marks))[0], ['check', Math.round(0.3 * 560 * 4) + 1])
  await pg.mouse.move(5, 5)
  // a page of forty screens: the loupe, and a click on a mark in it goes to the mark
  await pg.evaluate(() => (window as any).__report(40))
  const long = (await ruler(pg)).bar!
  await pg.mouse.move(long.left + long.width / 2, long.top + long.height * 0.104)
  await pg.waitForTimeout(450)
  const opened = await ruler(pg)
  assert.equal(opened.open, true, 'the loupe opens on a long page')
  const box = opened.box!
  await pg.mouse.move(long.left - 4, long.top + long.height * 0.104, { steps: 2 })
  // the loupe shows two screens of the page around the pointer: the mark at 10.4% in its middle
  await pg.mouse.move(box.right - 12, (box.top + box.bottom) / 2 + 1, { steps: 3 })
  await pg.waitForTimeout(100)
  assert.equal((await ruler(pg)).tip, 'Alternative explanations', 'the mark under the pointer named')
  await pg.evaluate(() => ((window as any).__marks = []))
  await pg.mouse.click(box.right - 12, (box.top + box.bottom) / 2 + 1)
  assert.deepEqual((await pg.evaluate(() => (window as any).__marks))[0], ['check', Math.round(0.104 * 560 * 40) + 1])
  await pg.close()
})
