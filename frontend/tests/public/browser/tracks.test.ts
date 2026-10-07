// The reader's two tracks (src/files/Tracks.tsx ReaderTracks) with the app's stylesheets in headless Chromium, light
// and dark: the overview at the left with a dark frame exactly as wide as its track, the zoomed track at the outer
// edge; on the zoomed track the records past what the reader shows fade and those it shows are full, under a lens of
// the paper; two lines join the frame's corners to the lens's left edge, at a pixel ratio of 1 and 2 within half a
// device pixel, every edge on whole device pixels; at the file's end the lens goes down the zoomed
// track with the frame; each pixel row of the overview is one color; the find's matches leave ticks in the ink, no
// color; hovering the overview shows the records at that point beside the tracks, without scrolling, in plain rows
// with a straight bar, and a find's tick says what is found; a press on the overview scrubs the reader.
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

/** A page of the bundle at a device pixel ratio. */
async function open(dpr: number): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1000, height: 640 }, deviceScaleFactor: dpr })
  await page.route('**/*', (route) => {
    const p = new URL(route.request().url()).pathname
    if (p === '/')
      return route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: '<!doctype html><html lang="en"><head><meta charset="utf-8"><link rel="stylesheet" href="/bundle.css"></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>',
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
  await page.goto(`${ORIGIN}/`)
  await page.waitForSelector('.track-lens')
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
      `import { PlaceFeed, ReaderTracks } from '${src('files/Tracks.tsx')}'`,
      `const w = window as any`,
      `w.__seeks = []`,
      `w.__asked = []`,
      `const root = createRoot(document.getElementById('root')!)`,
      // three values over 100 bins: the first two thirds mostly the first value, the second beside it in every bin, the
      // last third the third value
      `const counts = [Array.from({ length: 100 }, (_, i) => (i < 66 ? 5 : 0)), Array.from({ length: 100 }, (_, i) => (i < 66 ? 2 : 1)), Array.from({ length: 100 }, (_, i) => (i < 66 ? 0 : 6))]`,
      `const records = (base) => Array.from({ length: 20 }, (_, i) => ({ line: base + i, top: i * 100, bottom: i * 100 + 90 }))`,
      `const colorOf = (line) => ({ color: line % 2 ? 'var(--label-2)' : 'var(--label-1)', title: 'v' })`,
      `const feed = new PlaceFeed()`,
      `w.__feed = feed`,
      `const markers = [{ id: 'find', name: '"county"', total: 1000, ticks: [{ from: 400, to: 420, colour: 'var(--text-primary)' }] }]`,
      `const preview = (line) => { w.__asked.push(line); return Promise.resolve([{ line, who: 'AgentRelent', when: '2026-06-18 20:15', text: 'SEC county variants for pretty lines', color: 'var(--label-1)' }, { line: line + 1, who: 'AgentMapCite8x', when: '2026-06-18 20:16', text: 'MINETHROUGH PERSIST 777', color: 'var(--label-2)' }]) }`,
      // the middle of the file (the reader at 800 to 1200 of the 2000 px the zoomed track spans, in a stretch of the
      // file's records), or near its end (1500 to 1900 of the last 2000 px)
      // (the file twenty times what the reader shows, so that the zoomed track shows; "short" five times, so that it
      // does not)
      `const at = { middle: { place: { top: 0.475, height: 0.05, scroll: 800, h: 400, content: 4000, start: false, end: false }, records: records(100) }, end: { place: { top: 0.93, height: 0.05, scroll: 1500, h: 400, content: 2000, start: true, end: true }, records: records(900) }, short: { place: { top: 0.4, height: 0.2, scroll: 800, h: 400, content: 2000, start: true, end: true }, records: records(1) } }`,
      `root.render(<div style={{ height: 600, display: 'flex', justifyContent: 'flex-end' }}><ReaderTracks total={1000} feed={feed} paint={{ kind: 'counts', counts, colors: ['var(--label-1)', 'var(--label-2)', 'var(--label-3)'], faded: [false, false, false] }} markers={markers} colorOf={colorOf} onJump={() => {}} onSeek={(f, held) => w.__seeks.push([f, held])} onScrollBy={(px) => { w.__scrolled.push(px); const p = feed.place; feed.set({ ...p, scroll: p.scroll + px, top: p.top + px / 40000 }); return px }} onMark={() => {}} preview={preview} /></div>)`,
      `w.__scrolled = []`,
      // the place published, then once the tracks have gone still and onto the pixel grid
      `w.__render = (where) => { flushSync(() => { feed.set(at[where].place); feed.setRecords(at[where].records) }); return new Promise((r) => setTimeout(r, 250)) }`,
      `w.__render('middle')`,
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

/** The tracks as laid out: each part's box, the lines' ends in the page, and what the lens and frame are drawn in. */
const layout = (pg: Page = page) =>
  pg.evaluate(() => {
    const box = (sel: string) => {
      const r = document.querySelector(sel)!.getBoundingClientRect()
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }
    }
    const svg = document.querySelector('.track-link') as SVGSVGElement
    const sr = svg.getBoundingClientRect()
    const line = (edge: string) => {
      const l = svg.querySelector(`line[data-edge="${edge}"]`)!
      const n = (a: string) => Number(l.getAttribute(a))
      return { x1: sr.left + n('x1'), y1: sr.top + n('y1'), x2: sr.left + n('x2'), y2: sr.top + n('y2'), stroke: getComputedStyle(l).stroke }
    }
    const frame = document.querySelector('.track-frame-over')!
    const lens = document.querySelector('.track-lens')!
    return {
      over: box('.track-over'),
      zoom: box('.track-zoom'),
      frame: box('.track-frame-over'),
      lens: box('.track-lens'),
      shown: box('.track-zoom-shown'),
      top: line('top'),
      bottom: line('bottom'),
      polygon: svg.querySelector('polygon')!.getAttribute('points'),
      frameBorder: getComputedStyle(frame).borderTopColor,
      frameWidth: parseFloat(getComputedStyle(frame).borderTopWidth),
      lensBg: getComputedStyle(lens).backgroundColor,
      radius: parseFloat(getComputedStyle(lens).borderTopLeftRadius),
      zoomBox: box('.track-zoom'),
      ring: ['top', 'right', 'bottom', 'left'].map((side) => getComputedStyle(frame).getPropertyValue(`border-${side}-width`)),
      lensBorder: getComputedStyle(lens).borderTopColor,
      faded: getComputedStyle(document.querySelector('.track-zoom-faded')!).opacity,
      full: [...document.querySelectorAll('.track-zoom-shown [data-line]')].map((e) => Number((e as HTMLElement).dataset.line)),
    }
  })

const near = (a: number, b: number, tol = 1) => Math.abs(a - b) <= tol

for (const theme of ['light', 'dark']) {
  test(`the overview at the left, the zoomed track at the edge, the lines joining the frame to the lens, in the ${theme} theme`, async () => {
    await page.evaluate((t) => document.documentElement.setAttribute('data-paper', t === 'dark' ? 'dark' : 'warm'), theme)
    await page.evaluate(() => (window as any).__render('middle'))
    const g = await layout()
    // the order: the overview, then the zoomed track at the outer edge
    assert.ok(g.over.right < g.zoom.left, `the overview left of the zoomed track: ${JSON.stringify([g.over, g.zoom])}`)
    // the overview's frame: exactly as wide as its track, in the full ink
    assert.equal(g.frame.width, g.over.width)
    assert.equal(g.frame.left, g.over.left)
    assert.ok(g.frameWidth >= 2, `frame border ${g.frameWidth}`)
    const ink = g.frameBorder.match(/[\d.]+/g)!.map(Number)
    assert.ok(ink.length === 3 || ink[3] > 0.9, `the frame in the full ink: ${g.frameBorder}`)
    // the zoomed track: faded past what the reader shows, which is full under the lens (800 to 1200 of 2000 px)
    assert.ok(Math.abs(Number(g.faded) - 0.28) < 0.01, `faded at ${g.faded}`)
    assert.ok(near(g.shown.top - g.zoom.top, g.zoom.height * 0.4) && near(g.shown.height, g.zoom.height * 0.2), JSON.stringify(g))
    assert.ok(g.full.includes(108) && g.full.includes(111), `full records ${g.full}`)
    // the lens: a margin outside the part shown, wider than the track, of the paper, framed
    assert.ok(near(g.lens.top, g.shown.top - 3) && near(g.lens.bottom, g.shown.bottom + 3), JSON.stringify([g.lens, g.shown]))
    assert.ok(g.lens.left < g.zoom.left && g.lens.right > g.zoom.right)
    assert.notEqual(g.lensBg, 'rgba(0, 0, 0, 0)')
    assert.notEqual(g.lensBorder, 'rgba(0, 0, 0, 0)')
    // the lines: from the frame's right edge at its top and bottom to the lens's left edge at its top and bottom
    assert.ok(near(g.top.x1, g.frame.right) && near(g.top.y1, g.frame.top) && near(g.top.x2, g.lens.left) && near(g.top.y2, g.lens.top + g.radius), `top line ${JSON.stringify([g.top, g.frame, g.lens])}`)
    assert.ok(near(g.bottom.x1, g.frame.right) && near(g.bottom.y1, g.frame.bottom) && near(g.bottom.x2, g.lens.left) && near(g.bottom.y2, g.lens.bottom - g.radius), `bottom line ${JSON.stringify([g.bottom, g.frame, g.lens])}`)
    assert.notEqual(g.top.stroke, 'none')
    assert.ok(g.polygon && g.polygon.split(' ').length === 4)
  })
}

test("near the file's end the lens goes down the zoomed track with the frame, and the lines follow both", async () => {
  await page.evaluate(() => (window as any).__render('middle'))
  const mid = await layout()
  await page.evaluate(() => (window as any).__render('end'))
  const end = await layout()
  // in the middle both stand in the middle; near the end both stand near the bottom of their tracks
  const frameAt = (g: typeof mid) => (g.frame.top - g.over.top) / (g.over.height - g.frame.height)
  const lensAt = (g: typeof mid) => (g.shown.top - g.zoom.top) / (g.zoom.height - g.shown.height)
  assert.ok(near(frameAt(mid), 0.5, 0.02) && near(lensAt(mid), 0.5, 0.02), `${frameAt(mid)} ${lensAt(mid)}`)
  assert.ok(lensAt(end) > 0.9 && frameAt(end) > 0.9, `${frameAt(end)} ${lensAt(end)}`)
  assert.ok(end.lens.top - mid.lens.top > 150, 'the lens moved down the zoomed track')
  assert.ok(near(end.top.y2, end.lens.top + end.radius) && near(end.bottom.y2, end.lens.bottom - end.radius) && near(end.top.y1, end.frame.top) && near(end.bottom.y1, end.frame.bottom), JSON.stringify(end))
  await page.evaluate(() => (window as any).__render('middle'))
})

for (const dpr of [1, 2]) {
  test(`at a pixel ratio of ${dpr}, every edge stands on whole device pixels and each line's ends meet the corners within half a device pixel`, async () => {
    const pg = await open(dpr)
    for (const where of ['middle', 'end']) {
      await pg.evaluate((w) => (window as any).__render(w), where)
      const g = await layout(pg)
      const tol = 0.5 / dpr + 1e-6
      const on = (v: number) => Math.abs(v * dpr - Math.round(v * dpr)) < 1e-3
      const at = `${where} ${JSON.stringify(g)}`
      // the frame's and the lens's edges on the device's pixel grid
      for (const v of [g.frame.top, g.frame.bottom, g.frame.left, g.frame.right, g.lens.top, g.lens.bottom, g.lens.left, g.lens.right, g.shown.top, g.shown.bottom]) assert.ok(on(v), `${v} off the grid, ${at}`)
      // the ring the same on its four sides, the lens's margin of the paper the same on its four
      assert.equal(new Set(g.ring).size, 1, at)
      assert.ok([g.shown.top - g.lens.top, g.lens.bottom - g.shown.bottom, g.zoomBox.left - g.lens.left, g.lens.right - g.zoomBox.right].every((m) => Math.abs(m - 3) < 1e-3), at)
      // each line from the frame's outer corner to the lens's left edge where its corner's curve ends
      const ends = [
        [g.top.x1, g.frame.right], [g.top.y1, g.frame.top], [g.top.x2, g.lens.left], [g.top.y2, g.lens.top + g.radius],
        [g.bottom.x1, g.frame.right], [g.bottom.y1, g.frame.bottom], [g.bottom.x2, g.lens.left], [g.bottom.y2, g.lens.bottom - g.radius],
      ]
      ends.forEach(([a, b], i) => assert.ok(Math.abs(a - b) <= tol, `end ${i}: ${a} against ${b}, ${at}`))
    }
    await pg.close()
  })
}

test("each pixel row of the overview is one color, and the find's matches leave ticks in the ink, no color", async () => {
  await page.evaluate(() => document.documentElement.setAttribute('data-paper', 'warm'))
  await page.waitForTimeout(50)
  const rows = await page.evaluate(() => {
    const cv = document.querySelector('.track-over canvas') as HTMLCanvasElement
    const ctx = cv.getContext('2d')!
    const data = ctx.getImageData(0, 0, cv.width, cv.height).data
    const px = (x: number, y: number) => Array.from(data.slice((y * cv.width + x) * 4, (y * cv.width + x) * 4 + 4))
    const dpr = window.devicePixelRatio || 1
    // the column after the one marker lane (3px, a 1px gap, then 1px)
    const x0 = Math.round(5 * dpr)
    let mixed = 0
    const colours = new Set<string>()
    for (let y = 0; y < cv.height; y++) {
      const row = new Set<string>()
      for (let x = x0; x < cv.width; x++) row.add(px(x, y).join(','))
      if (row.size > 1) mixed++
      colours.add([...row][0])
    }
    // the find's tick over lines 400 to 420 of 1000, in its lane
    const tick = px(1, Math.round(cv.height * 0.41))
    return { mixed, colours: colours.size, tick }
  })
  assert.equal(rows.mixed, 0, 'no row holds two colors side by side')
  assert.equal(rows.colours, 2, 'the first two thirds the first value, the last third the third')
  const [r, g, b, a] = rows.tick
  assert.ok(a > 0 && Math.max(r, g, b) - Math.min(r, g, b) < 12, `the find's tick has no color: ${rows.tick}`)
})

test("hovering the overview shows the records at that point in plain rows with a straight bar, and a find's tick what is found", async () => {
  const over = (await page.locator('.track-over').boundingBox())!
  await page.mouse.move(over.x + over.width - 3, over.y + over.height * 0.3)
  await page.mouse.move(over.x + over.width - 2, over.y + over.height * 0.3 + 1)
  await page.waitForSelector('.track-preview .track-preview-text')
  const text = await page.locator('.track-preview').innerText()
  assert.match(text, /AgentRelent/)
  assert.match(text, /SEC county variants/)
  const style = await page.evaluate(() => {
    const p = document.querySelector('.track-preview')!
    const rec = document.querySelector('.track-preview-rec')!
    return { box: parseFloat(getComputedStyle(p).borderTopLeftRadius), rec: getComputedStyle(rec).borderTopLeftRadius, bar: getComputedStyle(rec).boxShadow, ui: parseFloat(getComputedStyle(document.body).getPropertyValue('--radius-ui')) }
  })
  assert.ok(style.box <= style.ui, `the popover's corners at most a control's: ${style.box}`)
  assert.equal(style.rec, '0px', 'each record a plain row')
  assert.match(style.bar, /inset/, 'its color a bar on its left edge')
  const asked = await page.evaluate(() => (window as any).__asked as number[])
  assert.ok(
    asked.every((l) => l >= 290 && l <= 310),
    `asked ${asked}`,
  )
  // the find's lane at the overview's left: the tick over lines 400 to 420
  await page.mouse.move(over.x + 1.5, over.y + over.height * 0.41)
  await page.waitForSelector('.reader-ruler-tip')
  assert.equal(await page.locator('.reader-ruler-tip').innerText(), '"county"')
  assert.equal(await page.locator('.track-preview').count(), 0)
})

test('a press on the overview sends the frame there and scrubs the reader', async () => {
  const over = (await page.locator('.track-over').boundingBox())!
  await page.mouse.move(over.x + over.width - 3, over.y + over.height * 0.8)
  await page.mouse.down()
  await page.mouse.move(over.x + over.width - 3, over.y + over.height * 0.85, {
    steps: 4,
  })
  await page.mouse.up()
  const seeks = await page.evaluate(() => (window as any).__seeks as [number, boolean][])
  assert.ok(seeks.length >= 2 && seeks[0][1] === true && seeks[seeks.length - 1][1] === false, JSON.stringify(seeks))
  assert.ok(seeks[seeks.length - 1][0] > seeks[0][0])
})

/** The lens's top and the first faded record's top on the zoomed track, and the zoomed track's cursor. */
const zoomState = (pg: Page = page) =>
  pg.evaluate(() => {
    const top = (sel: string) => document.querySelector(sel)!.getBoundingClientRect().top
    return { lens: top('.track-lens'), rec: top('.track-zoom-faded .track-rec'), cursor: getComputedStyle(document.querySelector('.track-zoom')!).cursor, scrolled: ((window as any).__scrolled as number[]).reduce((a, b) => a + b, 0) }
  })

test("a drag on the lens scrolls the reader at the zoomed track's scale: the lens follows the pointer over records that hold still", async () => {
  await page.evaluate(() => (window as any).__render('middle'))
  await page.evaluate(() => ((window as any).__scrolled = []))
  const zoom = (await page.locator('.track-zoom').boundingBox())!
  const lens = (await page.locator('.track-lens').boundingBox())!
  const before = await zoomState()
  assert.equal(before.cursor, 'grab', 'the zoomed track says it can be dragged')
  const x = zoom.x + zoom.width / 2
  const y = lens.y + lens.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  for (let i = 1; i <= 20; i++) await page.mouse.move(x, y - 2 * i)
  await page.waitForTimeout(50)
  const during = await zoomState()
  assert.equal(during.cursor, 'grabbing')
  // the lens went up with the pointer, the records under it stayed where they were
  assert.ok(Math.abs(during.lens - (before.lens - 40)) <= 1, `lens ${before.lens} → ${during.lens}`)
  assert.ok(Math.abs(during.rec - before.rec) <= 0.5, `records ${before.rec} → ${during.rec}`)
  // and the reader scrolled up by 40 px of the zoomed track: the stretch's 2,000 px over the track's height
  const k = zoom.height / 2000
  assert.ok(Math.abs(during.scrolled - -40 / k) <= 2 / k, `scrolled ${during.scrolled}, wanted ${-40 / k}`)
  await page.mouse.up()
  // let go, the lens glides back to where the frame puts it, the middle of the track
  await page.waitForTimeout(400)
  const after = await zoomState()
  const back = (after.lens - zoom.y + 3) / (zoom.height - (lens.height - 6))
  assert.ok(Math.abs(back - 0.5) < 0.02, `the lens back at ${back}`)
  assert.equal(after.cursor, 'grab')
})

test('a press on the zoomed track off the lens brings the lens there, and a drag goes on from there', async () => {
  await page.evaluate(() => (window as any).__render('middle'))
  await page.evaluate(() => ((window as any).__scrolled = []))
  const zoom = (await page.locator('.track-zoom').boundingBox())!
  const lens = (await page.locator('.track-lens').boundingBox())!
  const x = zoom.x + zoom.width / 2
  const y = lens.y + lens.height + 60
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.waitForTimeout(80)
  const pressed = (await page.locator('.track-lens').boundingBox())!
  assert.ok(Math.abs(pressed.y + pressed.height / 2 - y) <= 1, `the lens's middle at ${pressed.y + pressed.height / 2}, the pointer at ${y}`)
  for (let i = 1; i <= 10; i++) await page.mouse.move(x, y + i)
  await page.waitForTimeout(50)
  const dragged = (await page.locator('.track-lens').boundingBox())!
  assert.ok(Math.abs(dragged.y - (pressed.y + 10)) <= 1, `the drag went on: ${pressed.y} → ${dragged.y}`)
  const k = zoom.height / 2000
  const scrolled = await page.evaluate(() => ((window as any).__scrolled as number[]).reduce((a, b) => a + b, 0))
  assert.ok(Math.abs(scrolled - (y + 10 - (lens.y + lens.height / 2)) / k) <= 2 / k, `scrolled ${scrolled}`)
  await page.mouse.up()
  await page.waitForTimeout(300)
})

test('the zoomed track shows only on a file at least twelve times what the reader shows', async () => {
  const shows = () => page.evaluate(() => getComputedStyle(document.querySelector('.track-zoom')!).display !== 'none' && getComputedStyle(document.querySelector('.track-link')!).display !== 'none')
  await page.evaluate(() => (window as any).__render('middle'))
  assert.equal(await shows(), true, 'twenty times: the zoomed track')
  await page.evaluate(() => (window as any).__render('short'))
  assert.equal(await shows(), false, 'five times: the overview alone')
  const over = await page.evaluate(() => document.querySelector('.tracks')!.getBoundingClientRect().width)
  await page.evaluate(() => (window as any).__render('middle'))
  assert.equal(await shows(), true)
  assert.ok((await page.evaluate(() => document.querySelector('.tracks')!.getBoundingClientRect().width)) > over + 30, 'the tracks narrower without it')
})

