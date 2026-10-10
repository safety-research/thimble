// The reader's strip (src/files/Tracks.tsx ReaderTracks), its loupe (src/files/Loupe.tsx) and the report's ruler
// (src/files/Ruler.tsx PageRuler) with the app's stylesheets in headless Chromium, light and dark.
//
// The strip is one track at every length: the find's lane and a lane of colors in the scrollbar's geometry, no second
// track, a thumb exactly as wide as the strip, its edges on whole device pixels at a pixel ratio of 1 and 2 once still;
// each pixel row of a lane is one color and the find's matches are ticks in the ink. Resting on the strip opens the loupe
// beside it after LOUPE_REST_MS, not before, with a bracket beside the strip over the stretch it shows: a line per
// record, its number, its cells in its own colors once read, and the start of its text, the pointer's record in the
// middle line and darker. It follows the pointer along the strip, never jumping to the thumb while the reader's place
// moves under it, and the thumb once the reader scrolls on the wheel or the thumb is dragged; moved into, it holds still
// with no tooltip, the line under the pointer darker; a click goes to that record and leaves its lines where they are,
// and the wheel scrolls the reader once per turn while the loupe keeps its place and its lines follow; out of both, it
// closes. A touch press on the strip opens it, a drag scrubs and the release goes to the record under its line. A strip
// that tells every record apart opens no loupe and names the record under the pointer on one line. A click on a find's
// tick goes to it, and a press on the strip sends the thumb there and scrubs. The report's ruler is the same one strip:
// a mark names its passage on hover on a short page, on one line; the loupe opens on a long one, a line per passage, and
// a click on a line goes to its passage.
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
      `const w = window as any`,
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

test("a file of twelve million records whose texts are long: each line its whole number and every cell, its time and who said it in the quiet gray, its text in the ink, which alone gives up room", async () => {
  const pg = await open(1, 12_000_000, true)
  await rest(0.3, pg)
  await pg.waitForTimeout(200)
  const got = await pg.evaluate(() => {
    const probe = document.createElement('span')
    document.body.appendChild(probe)
    probe.style.color = 'var(--text-tertiary)'
    const gray = getComputedStyle(probe).color
    probe.style.color = 'var(--text-primary)'
    const ink = getComputedStyle(probe).color
    probe.remove()
    const box = document.querySelector('.loupe-box')!.getBoundingClientRect()
    return {
      gray,
      ink,
      box: { left: box.left, right: box.right },
      rows: [...document.querySelectorAll('.loupe[data-open] .loupe-row')].map((r) => {
        const n = r.querySelector('.loupe-n')!
        const range = document.createRange()
        range.selectNodeContents(n)
        const nb = range.getBoundingClientRect()
        const cells = [...r.querySelectorAll('.loupe-cell')].map((i) => i.getBoundingClientRect())
        const t = r.querySelector('.loupe-t') as HTMLElement
        const meta = [...t.querySelectorAll('.loupe-m')]
        return {
          n: n.textContent ?? '',
          nLeft: nb.left,
          nRight: nb.right,
          cells: cells.map((c) => c.width),
          cellsLeft: cells[0].left,
          cellsRight: cells[cells.length - 1].right,
          meta: meta.map((m) => m.textContent ?? ''),
          metaInk: meta.map((m) => getComputedStyle(m).color),
          textInk: getComputedStyle(t).color,
          textLeft: t.getBoundingClientRect().left,
          cut: t.scrollWidth > t.clientWidth,
        }
      }),
    }
  })
  assert.equal(got.rows.length, 17)
  assert.notEqual(got.gray, got.ink)
  for (const r of got.rows) {
    const n = Number(r.n)
    assert.ok(/^\d{7}$/.test(r.n) && r.nLeft >= got.box.left && r.nRight <= r.cellsLeft, `the whole number, inside the loupe: ${JSON.stringify([r, got.box])}`)
    assert.deepEqual(r.cells, [4, 4], 'the find\'s cell and the color lane\'s, each whole')
    assert.deepEqual(r.meta, ['20:' + String(n % 60).padStart(2, '0') + ':07', 'AgentRelent'])
    assert.deepEqual(r.metaInk, [got.gray, got.gray], 'its time and who said it in the quiet gray')
    assert.equal(r.textInk, got.ink, 'its text in the ink')
    assert.ok(r.cut && r.textLeft >= r.cellsRight, `the text alone cut: ${JSON.stringify(r)}`)
  }
  await pg.close()
})

test('the loupe follows the pointer along the strip and never jumps to the thumb as the reader moves under it; the wheel moves it to the thumb', async () => {
  await reset()
  const over = await rest(0.3)
  const x = over.x + over.width / 2
  const a = await layout()
  // along the strip a little at a time, the reader's place moving by a hair at each step
  for (let i = 1; i <= 12; i++) {
    await page.evaluate((k) => (window as any).__nudge(k), i)
    const y = over.y + over.height * (0.3 + i * 0.01)
    await page.mouse.move(x, y)
    await page.evaluate((k) => (window as any).__nudge(k + 0.5), i)
    await page.waitForTimeout(20)
    const g = await layout()
    const mid = (g.loupe!.top + g.loupe!.bottom) / 2
    assert.ok(near(mid, y, 2), `step ${i}: the loupe's middle ${mid}, the pointer ${y}, the thumb ${(g.frame.top + g.frame.bottom) / 2}`)
    assert.ok(g.rows[8].at && !g.rows.some((r) => r.seen), `step ${i}: the pointer's record darker, none on screen`)
  }
  await page.mouse.move(x, over.y + over.height * 0.6, { steps: 5 })
  await page.waitForTimeout(50)
  const b = await layout()
  assert.ok(b.loupe!.top - a.loupe!.top > over.height * 0.25, `followed: ${a.loupe!.top} → ${b.loupe!.top}`)
  assert.ok(b.bracket!.top - a.bracket!.top > over.height * 0.25)
  // the wheel over the strip scrolls the reader: the loupe goes to the thumb, in the middle of the file, its lines those
  // on screen
  await page.evaluate(() => ((window as any).__scrolled = []))
  for (let i = 0; i < 3; i++) await page.mouse.wheel(0, 100)
  await page.waitForTimeout(150)
  const c = await layout()
  const scrolled = await page.evaluate(() => ((window as any).__scrolled as number[]).reduce((s, x) => s + x, 0))
  assert.ok(scrolled >= 300, `the wheel scrolled the reader ${scrolled}`)
  assert.equal(c.open, true)
  assert.ok(near((c.loupe!.top + c.loupe!.bottom) / 2, (c.frame.top + c.frame.bottom) / 2, 2), `at the thumb: ${JSON.stringify([c.loupe, c.frame])}`)
  assert.ok(near((c.bracket!.top + c.bracket!.bottom) / 2, (c.frame.top + c.frame.bottom) / 2, 2))
  assert.ok(c.rows.every((r) => r.seen) && !c.rows.some((r) => r.at), 'its lines on screen, tinted, none darker')
  // out of the strip to the right, away from the loupe: it closes
  await page.mouse.move(over.x + over.width + 3, over.y + over.height * 0.6)
  await page.waitForTimeout(50)
  assert.equal((await layout()).open, false)
})

test('moved into, the loupe holds still: a click goes to the record and keeps its lines, the wheel scrolls the reader and its lines follow', async () => {
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
  assert.equal(b.tips, 0, 'no tooltip')
  const k = b.rows.findIndex((r) => r.at)
  assert.ok(k >= 0 && b.rows[k].top <= y && y < b.rows[k].top + 16, `the line under the pointer darker: ${k}`)
  const line = num(b.rows[k].n)
  // a click goes to that record; the reader moves there, and the lines stay where they are, the record on screen now
  await page.mouse.click(a.loupe!.right - 12, y)
  assert.deepEqual(await page.evaluate(() => (window as any).__lines), [line])
  await page.waitForTimeout(300)
  const c = await layout()
  assert.deepEqual(c.rows.map((r) => r.n), b.rows.map((r) => r.n), 'a click leaves the lines where they are')
  assert.equal(c.loupe!.top, b.loupe!.top)
  assert.ok(c.rows[k].seen && c.rows[k].at, 'the record gone to is on screen, still under the pointer')
  // the wheel over it scrolls the reader once a turn, and the loupe keeps its place while its lines follow
  await page.evaluate(() => ((window as any).__scrolled = []))
  await page.mouse.wheel(0, 2800)
  await page.waitForTimeout(150)
  const d = await layout()
  assert.deepEqual(await page.evaluate(() => (window as any).__scrolled), [2800], 'the reader scrolled once')
  assert.equal(d.loupe!.top, b.loupe!.top, 'the loupe kept its place')
  assert.equal(d.frozen, true)
  assert.ok(num(d.rows[0].n) - num(c.rows[0].n) > 50, `its lines followed the scroll: ${c.rows[0].n} → ${d.rows[0].n}`)
  assert.ok(d.rows.some((r) => r.seen))
  assert.equal(d.rows.findIndex((r) => r.at), k, 'the line under the pointer still darker')
  // back on the strip it follows the pointer again; out of both it closes
  await page.mouse.move(over.x + over.width / 2, over.y + over.height * 0.7, { steps: 4 })
  await page.waitForTimeout(50)
  const e = await layout()
  assert.equal(e.frozen, false)
  assert.ok(e.loupe!.top > d.loupe!.top + 50)
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

test('a strip that tells every record apart opens no loupe, and names the record under the pointer on one line', async () => {
  const pg = await open(1, 150)
  const over = (await pg.locator('.track-over').boundingBox())!
  await pg.mouse.move(over.x + over.width / 2, over.y + over.height * 0.5)
  await pg.waitForTimeout(500)
  const g = await layout(pg)
  assert.equal(g.open, false)
  // its number, no word before it, then who said it and the start of its text, on one line
  assert.equal(g.rulerTip, '76AgentRelentmessage 76 about the county')
  assert.ok(g.rulerTipOne && g.rulerTipH < 36, `one line: ${g.rulerTipH} px`)
  // a record of the first value: its cell in its color
  await pg.mouse.move(over.x + over.width / 2, over.y + (over.height * 69.5) / 150)
  await pg.waitForTimeout(500)
  const cells = await pg.evaluate(() => [...document.querySelectorAll('.reader-ruler-tip .tip-c i')].map((i) => (i as HTMLElement).style.background))
  assert.match((await layout(pg)).rulerTip ?? '', /^70Agent/)
  assert.deepEqual(cells, ['var(--label-1)'])
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
      tip: document.querySelector('.reader-ruler-tip')?.textContent ?? null,
      tipOne: document.querySelector('.reader-ruler-tip')?.classList.contains('tip-one') ?? false,
      tips: document.querySelectorAll('.tip').length,
      rows: [...document.querySelectorAll('.loupe[data-open] .loupe-row')].map((row) => ({
        n: row.querySelector('.loupe-n')!.textContent ?? '',
        text: row.querySelector('.loupe-t')!.textContent ?? '',
        cells: [...row.querySelectorAll('.loupe-cell')].map((i) => (i as HTMLElement).style.background),
        heading: row.classList.contains('heading'),
        at: row.classList.contains('at'),
      })),
    }
  })

test("the report's ruler is one strip: on a short page a mark names its passage on one line, on a long page the loupe, a line per passage", async () => {
  const pg = await open(1)
  await pg.evaluate(() => (window as any).__report(4))
  const short = await ruler(pg)
  assert.equal(short.second, 0, 'no second rail, no lens')
  assert.equal(short.bar!.width, 13, 'one lane in the scrollbar')
  assert.match(short.thumb!, /finder/)
  const bar = short.bar!
  // the mark at 30% of a page of four screens, on passage 8
  const y = bar.top + bar.height * 0.3 + 2
  await pg.mouse.move(bar.left + bar.width / 2, y)
  await pg.waitForTimeout(450)
  const hover = await ruler(pg)
  assert.equal(hover.open, false, 'a page the strip shows large enough opens no loupe')
  assert.equal(hover.tip, 'Passage 8 of the report, which goes on for a while')
  assert.equal(hover.tipOne, true)
  await pg.evaluate(() => ((window as any).__marks = []))
  await pg.mouse.click(bar.left + bar.width / 2, y)
  assert.deepEqual((await pg.evaluate(() => (window as any).__marks))[0], ['check', Math.round(0.3 * 560 * 4) + 1])
  await pg.mouse.move(5, 5)
  // a page of forty screens: the loupe, a line per passage around the pointer's, those the marks are on in the check's
  // color, the headings heavier, no numbers
  await pg.evaluate(() => (window as any).__report(40))
  const long = (await ruler(pg)).bar!
  await pg.mouse.move(long.left + long.width / 2, long.top + long.height * 0.104)
  await pg.waitForTimeout(450)
  const opened = await ruler(pg)
  assert.equal(opened.open, true, 'the loupe opens on a long page')
  assert.equal(opened.rows.length, 17)
  // 10.4% of 22,400 px is in passage 29, the middle line, from passage 21
  assert.deepEqual(opened.rows.map((r) => r.text.split(' ')[1]), Array.from({ length: 17 }, (_, i) => String(21 + i)))
  assert.ok(opened.rows[8].at)
  assert.ok(opened.rows.every((r) => r.n === ''), 'no numbers in the report')
  assert.deepEqual(opened.rows.map((r) => r.cells[0]), opened.rows.map((_, i) => ([28, 29, 30].includes(21 + i) ? 'var(--label-3)' : '')))
  assert.deepEqual(opened.rows.filter((r) => r.heading).map((r) => r.text.split(' ')[1]), ['30'])
  // into it, and a click on the middle line goes to passage 29
  const box = opened.box!
  await pg.mouse.move(long.left - 4, long.top + long.height * 0.104, { steps: 2 })
  await pg.mouse.move(box.right - 12, (box.top + box.bottom) / 2 + 1, { steps: 3 })
  await pg.waitForTimeout(100)
  const held = await ruler(pg)
  assert.equal(held.tips, 0, 'no tooltip in the loupe')
  assert.ok(held.rows[8].at)
  await pg.evaluate(() => ((window as any).__marks = []))
  await pg.mouse.click(box.right - 12, (box.top + box.bottom) / 2 + 1)
  const [jump] = await pg.evaluate(() => (window as any).__marks)
  assert.equal(jump[0], 'jump')
  assert.ok(Math.abs(jump[1] - (29 * 80 + 35) / 22_400) < 1e-9, `went to ${jump[1] * 22_400} px`)
  await pg.close()
})
