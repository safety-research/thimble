// A bar's round end in a real browser, read from its pixels on the light paper and the dark one: a card's chart
// (components/Outputs, lib/vegaDraw, lib/barEnds) and a custom card's own Vega-Lite drawn with thimble.vegaConfig in its
// frame (lib/frame chartScript). Vega-Lite 6.4.3 drew no bar that runs from x to x2 once the theme gave bars corners (a
// histogram's bins, thimble.chart's bars over time), and rounded a bar below zero at zero. Each chart is drawn twice,
// as written and with square bars (`cornerRadiusEnd: 0`, as before the theme rounded them, when every bar drew): each
// bar covers about as many pixels as its square twin, and is round at the end its value is at (a stack at the end of
// the whole stack) and square at its baseline. A corner is read against the two squares beside it along its edges and
// the one inside them, so the edges' own anti-aliasing, which a stack's clip doubles, is not taken for a round corner.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, test } from 'vitest'
import type { Browser, Page } from 'playwright'
import { bundle, cleanup, FRONTEND, launch, ORIGIN, src } from './page.ts'

const VL = 'https://vega.github.io/schema/vega-lite/v6.json'
const field = (name: string, type: string, more: Record<string, unknown> = {}) => ({ field: name, type, title: name, ...more })
type Spec = Record<string, any>

// the specs as thimble.chart writes them (backend kernel_thimble), on made-up rows
const BINS = [12, 30, 41, 22, 9, 3].map((count, i) => ({ minutes: i * 20, 'minutes end': i * 20 + 20, count }))
const binned = { x: field('minutes', 'quantitative', { bin: { binned: true, step: 20 }, axis: { format: ',~r' } }), x2: { field: 'minutes end' }, y: field('count', 'quantitative') }
const histogram = { $schema: VL, data: { values: BINS }, mark: 'bar', encoding: binned }
const BY_MODEL = ['opus', 'sonnet'].flatMap((model, g) => BINS.map((r) => ({ ...r, count: g ? Math.ceil(r.count / 2) : r.count, model, __thimble_stack: g })))
const stack = { color: field('model', 'nominal', { sort: ['opus', 'sonnet'] }), order: { field: '__thimble_stack', type: 'quantitative' } }
const stackedHistogram = { $schema: VL, data: { values: BY_MODEL }, mark: 'bar', encoding: { ...binned, ...stack } }
const DAYS = Array.from({ length: 8 }, (_, i) => ({ day: `2026-06-${16 + i}T00:00:00`, 'day end': `2026-06-${17 + i}T00:00:00`, opened: [3, 16, 8, 17, 7, 18, 4, 15][i] }))
const overTime = { $schema: VL, data: { values: DAYS }, mark: { type: 'bar', orient: 'vertical' }, encoding: { x: field('day', 'temporal'), x2: { field: 'day end' }, y: field('opened', 'quantitative') } }
const CHANGE = [{ model: 'opus', change: 0.12 }, { model: 'sonnet', change: 0.05 }, { model: 'haiku', change: -0.04 }, { model: 'other', change: -0.09 }]
const across = { $schema: VL, data: { values: CHANGE }, mark: 'bar', encoding: { y: field('model', 'nominal', { sort: CHANGE.map((r) => r.model) }), x: field('change in pass rate', 'quantitative', { field: 'change' }) } }
// an agent's own Altair: an aggregate, which Vega-Lite draws with no stack group
const summed = { $schema: VL, data: { values: CHANGE }, mark: 'bar', encoding: { x: field('model', 'nominal', { sort: CHANGE.map((r) => r.model) }), y: field('change', 'quantitative', { aggregate: 'sum' }) } }

/** The spec with square bars: `cornerRadiusEnd: 0` on its bar mark. */
const square = (s: Spec): Spec => ({ ...s, mark: { ...(typeof s.mark === 'string' ? { type: s.mark } : s.mark), cornerRadiusEnd: 0 } })

type Box = { left: number; top: number; right: number; bottom: number; fill: string; topFill: string; bottomFill: string }
/** Each bar of the square chart in `sel`'s svg, in its px from the svg's corner, a stack's segments as one bar. */
const barBoxes = (page: Page, sel: string, vertical: boolean): Promise<Box[]> =>
  page.evaluate(
    ([sel, vertical]) => {
      const svg = document.querySelector(`${sel} svg`)!.getBoundingClientRect()
      const segs = Array.from(document.querySelectorAll(`${sel} svg path[aria-roledescription="bar"]`)).map((p) => {
        const r = p.getBoundingClientRect()
        const fill = p.getAttribute('fill') ?? ''
        return { left: r.left - svg.left, top: r.top - svg.top, right: r.right - svg.left, bottom: r.bottom - svg.top, fill, topFill: fill, bottomFill: fill }
      }).filter((b) => b.right - b.left > 0.5 && b.bottom - b.top > 0.5)
      const out: typeof segs = []
      for (const s of segs) {
        const same = out.find((b) => (vertical ? Math.abs(b.left - s.left) < 0.5 && Math.abs(b.right - s.right) < 0.5 : Math.abs(b.top - s.top) < 0.5 && Math.abs(b.bottom - s.bottom) < 0.5))
        if (!same) out.push(s)
        else {
          if (s.top < same.top) [same.top, same.topFill] = [s.top, s.fill]
          if (s.bottom > same.bottom) [same.bottom, same.bottomFill] = [s.bottom, s.fill]
          same.left = Math.min(same.left, s.left)
          same.right = Math.max(same.right, s.right)
        }
      }
      return out
    },
    [sel, vertical] as const,
  )

const SCALE = 2
/** For each bar: how many device pixels each corner of the chart as written lacks, top left, top right, bottom left,
 * bottom right (a 2 px corner square read against the squares beside it, about 3.4 when round and 0 when square), and
 * how much of the bar the chart as written and its square twin cover in all. A pixel covers its share of the way from
 * the paper to the bar's color. Read in the page from the screenshots of the two svgs. */
async function coverage(page: Page, round: Buffer, flat: Buffer, boxes: Box[]) {
  return page.evaluate(
    async ([a, b, boxes, k]) => {
      const pixels = async (b64: string) => {
        const img = new Image()
        img.src = `data:image/png;base64,${b64}`
        await img.decode()
        const c = document.createElement('canvas')
        c.width = img.width
        c.height = img.height
        const g = c.getContext('2d')!
        g.drawImage(img, 0, 0)
        return { w: c.width, d: g.getImageData(0, 0, c.width, c.height).data }
      }
      const [r, f] = [await pixels(a), await pixels(b)]
      const hex = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16))
      // the paper, at the svg's top left corner, in its padding
      const paper = [f.d[0], f.d[1], f.d[2]]
      const cover = (p: typeof r, x0: number, y0: number, w: number, h: number, fill: string) => {
        const v = hex(fill).map((x, i) => x - paper[i])
        const len = v[0] * v[0] + v[1] * v[1] + v[2] * v[2]
        let sum = 0
        for (let y = y0; y < y0 + h; y++)
          for (let x = x0; x < x0 + w; x++) {
            const i = (y * p.w + x) * 4
            sum += Math.min(1, Math.max(0, ((p.d[i] - paper[0]) * v[0] + (p.d[i + 1] - paper[1]) * v[1] + (p.d[i + 2] - paper[2]) * v[2]) / len))
          }
        return sum
      }
      const n = 2 * k // a 2 px square, in device pixels
      return boxes.map((bx) => {
        const [L, T, R, B] = [Math.round(bx.left * k), Math.round(bx.top * k), Math.round(bx.right * k), Math.round(bx.bottom * k)]
        // the corner square at (x, y), stepping inward by (dx, dy): what it lacks of what the squares beside it predict
        const lacks = (x: number, y: number, dx: number, dy: number, fill: string) => {
          const at = (i: number, j: number) => cover(r, x + i * dx * n, y + j * dy * n, n, n, fill)
          return at(1, 0) + at(0, 1) - at(1, 1) - at(0, 0)
        }
        return {
          lacks: [lacks(L, T, 1, 1, bx.topFill), lacks(R - n, T, -1, 1, bx.topFill), lacks(L, B - n, 1, -1, bx.bottomFill), lacks(R - n, B - n, -1, -1, bx.bottomFill)],
          whole: [cover(r, L, T, R - L, B - T, bx.fill), cover(f, L, T, R - L, B - T, bx.fill)],
        }
      })
    },
    [round.toString('base64'), flat.toString('base64'), boxes, SCALE] as const,
  )
}

/** Each bar's corners, top left, top right, bottom left, bottom right: true where they are round. */
type Ends = [boolean, boolean, boolean, boolean]
const TOP: Ends = [true, true, false, false]
const BOTTOM: Ends = [false, false, true, true]
const RIGHT: Ends = [false, true, false, true]
const LEFT: Ends = [true, false, true, false]

function assertEnds(got: Awaited<ReturnType<typeof coverage>>, want: Ends[], what: string) {
  assert.equal(got.length, want.length, `${what}: ${got.length} bars`)
  got.forEach((bar, i) => {
    const [round, flat] = bar.whole
    // drawn: about as many pixels as its square twin, which the corners and the clip's softer edges take a little from
    assert.ok(flat > 50 && round >= flat * 0.95, `${what}, bar ${i}: covers ${round.toFixed(0)} px of its square twin's ${flat.toFixed(0)}`)
    bar.lacks.forEach((lack, j) => {
      if (want[i][j]) assert.ok(lack > 1, `${what}, bar ${i}: corner ${j} is square (lacks ${lack.toFixed(2)} px)`)
      else assert.ok(Math.abs(lack) < 0.5, `${what}, bar ${i}: corner ${j} is round (lacks ${lack.toFixed(2)} px)`)
    })
  })
}

let browser: Browser
let script = ''
let css = ''
// thimble's own builds of the libraries a custom card names (backend views.LIBS)
const LIBS = ['vega/build/vega.min.js', 'vega-lite/build/vega-lite.min.js', 'vega-embed/build/vega-embed.min.js'].map((p) => readFileSync(path.join(FRONTEND, 'node_modules', p), 'utf8'))

beforeAll(async () => {
  script = await bundle(
    'bar-ends',
    [
      `import '${src('styles/index.css')}'`,
      `import { createRoot } from 'react-dom/client'`,
      `import { flushSync } from 'react-dom'`,
      `import { Output } from '${src('components/Outputs.tsx')}'`,
      `import { chartScript } from '${src('lib/frame.ts')}'`,
      `const box = (id, width) => { const el = document.createElement('div'); el.id = id; el.style.width = width + 'px'; document.body.appendChild(el); return createRoot(el) }`,
      `window.__t = {`,
      `  chart: (id, spec, width) => flushSync(() => box(id, width).render(<Output bundle={{ 'application/vnd.vegalite.v6+json': spec }} fitWidth={width} card />)),`,
      `  chartScript,`,
      `}`,
    ],
    { loader: { '.css': 'css', '.woff2': 'dataurl', '.woff': 'empty' }, conditions: ['style'] },
  )
  css = readFileSync(script.replace(/\.js$/, '.css'), 'utf8')
  browser = await launch()
})

afterAll(async () => {
  await browser?.close()
  cleanup()
})

for (const paper of ['warm', 'dark'])
  describe(`on the ${paper} paper`, () => {
    let page: Page
    const logged: string[] = []

    beforeAll(async () => {
      page = await browser.newPage({ viewport: { width: 800, height: 900 }, deviceScaleFactor: SCALE })
      page.on('console', (m) => {
        if (m.type() === 'warning' || m.type() === 'error') logged.push(m.text())
      })
      page.on('pageerror', (e) => logged.push(e.message))
      await page.route('**/*', (route) => {
        const p = new URL(route.request().url()).pathname
        if (p === '/bundle.css') return route.fulfill({ status: 200, contentType: 'text/css', body: css })
        return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/bundle.css"></head><body></body></html>' })
      })
      await page.addInitScript((p) => localStorage.setItem('thimble:paper', p), paper)
      await page.goto(`${ORIGIN}/`)
      await page.addScriptTag({ path: script })
    })

    afterAll(() => page?.close())

    /** The chart drawn as written and with square bars, both in a card 560 px wide, and each bar's pixels in both. */
    const drawn = async (id: string, spec: Spec, vertical: boolean) => {
      for (const [at, s] of [[id, spec], [`${id}-square`, square(spec)]] as const) {
        await page.evaluate(([at, s]) => (window as any).__t.chart(at, s, 560), [at, s] as const)
        await page.waitForSelector(`#${at} [data-settled="true"] svg`, { timeout: 30_000 })
      }
      const boxes = await barBoxes(page, `#${id}-square`, vertical)
      const shot = (at: string) => page.locator(`#${at} svg`).screenshot({ animations: 'disabled' })
      return coverage(page, await shot(id), await shot(`${id}-square`), boxes)
    }

    test("a histogram's bins and bars over time are drawn, each round at its top", async () => {
      assertEnds(await drawn('histogram', histogram, true), Array(6).fill(TOP), 'histogram')
      assertEnds(await drawn('over-time', overTime, true), Array(8).fill(TOP), 'bars over time')
    })

    test('a stacked histogram is drawn, each stack round at the top of the whole stack only', async () => {
      assertEnds(await drawn('stacked', stackedHistogram, true), Array(6).fill(TOP), 'stacked histogram')
    })

    test('a bar below zero is round at its value, not at zero, across and upright', async () => {
      assertEnds(await drawn('across', across, false), [RIGHT, RIGHT, LEFT, LEFT], 'bars across')
      assertEnds(await drawn('summed', summed, true), [TOP, TOP, BOTTOM, BOTTOM], "an agent's summed bars")
      assert.deepEqual(logged, [])
    })

    test("a custom card's own Vega-Lite drawn with thimble.vegaConfig draws its histogram, round at the top", async () => {
      const style = await page.evaluate(() => (window as any).__t.chartScript() as string)
      const frame = await browser.newPage({ viewport: { width: 800, height: 600 }, deviceScaleFactor: SCALE })
      try {
        const html = [
          '<!doctype html><html><head><meta charset="utf-8">',
          style,
          ...LIBS.map((lib) => `<script>${lib.replace(/<\/script/gi, '<\\/script')}</script>`),
          '</head><body style="margin:0"><div id="round"></div><div id="flat"></div><script>',
          `const opts = { config: thimble.vegaConfig, actions: false, renderer: 'svg' };`,
          `Promise.all([vegaEmbed('#round', ${JSON.stringify(histogram)}, opts), vegaEmbed('#flat', ${JSON.stringify(square(histogram))}, opts)]).then(() => document.body.dataset.done = '1')`,
          '</script></body></html>',
        ].join('')
        await frame.route('**/*', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: html }))
        await frame.goto(`${ORIGIN}/card`)
        await frame.waitForSelector('body[data-done="1"]', { timeout: 30_000 })
        const boxes = await barBoxes(frame, '#flat', true)
        const shot = (at: string) => frame.locator(`#${at} svg`).screenshot({ animations: 'disabled' })
        assertEnds(await coverage(frame, await shot('round'), await shot('flat'), boxes), Array(6).fill(TOP), 'custom card histogram')
      } finally {
        await frame.close()
      }
    })
  })
