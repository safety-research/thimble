// A composite chart fitted to a room narrower than it was designed for (components/Outputs.tsx responsive), drawn by
// Vega in a real browser: a report's figure beside the margin is such a room. The spec is what altair writes for a
// limit line: views 640 px wide whose text layer places the limit's label at `x: {value: 640}`, the views' right edge.
// Each view also clips a step line whose data runs hours past the view's domain, as altair's `clip=True` does: what
// the clip cuts away is not drawing past the chart's edge. Fitted to 391 or 320 px, the views keep a readable width,
// the chart stays inside its room and its time labels do not run into each other.
import assert from 'node:assert/strict'
import { afterAll, beforeAll, test } from 'vitest'
import type { Browser, Page } from 'playwright'
import { bundle, cleanup, launch, ORIGIN, src } from './page.ts'

let browser: Browser
let page: Page

const times = ['02:00', '02:20', '02:40', '03:00', '03:20'].map((t, i) => ({ t: `2026-05-16T${t}:00Z`, n: 120 + i * 15 }))
const steps = ['00:00', '02:30', '05:00', '08:00', '11:00'].map((t, i) => ({ t: `2026-05-16T${t}:00Z`, n: 60 + i * 20 }))
const domain = ['2026-05-16T02:00:00Z', '2026-05-16T03:30:00Z']
const view = (title: string) => ({
  title,
  width: 640,
  height: 120,
  layer: [
    { data: { values: steps }, mark: { type: 'line', clip: true, interpolate: 'step-after' }, encoding: { x: { field: 't', type: 'temporal', scale: { domain } }, y: { field: 'n', type: 'quantitative' } } },
    { mark: { type: 'rule' }, encoding: { y: { datum: 200 } } },
    { mark: { type: 'text', align: 'right', dy: -6 }, encoding: { text: { value: 'limit 200' }, x: { value: 640 }, y: { datum: 200 } } },
    { mark: 'point', encoding: { x: { field: 't', type: 'temporal', title: 'time (UTC)', scale: { domain } }, y: { field: 'n', type: 'quantitative' } } },
  ],
})
const SPEC = {
  $schema: 'https://vega.github.io/schema/vega-lite/v5.json',
  data: { values: times },
  vconcat: [view('Night: database connections'), view('Morning: database connections')],
}

beforeAll(async () => {
  const script = await bundle('chart-fit', [
    `import { createRoot } from 'react-dom/client'`,
    `import { flushSync } from 'react-dom'`,
    `import { Output } from '${src('components/Outputs.tsx')}'`,
    `window.__t = { chart: (spec, width) => { const el = document.createElement('div'); el.style.width = width + 'px'; el.className = 'room-' + width; document.body.appendChild(el); flushSync(() => createRoot(el).render(<Output bundle={{ 'application/vnd.vegalite.v5+json': spec }} fitWidth={width} />)) } }`,
  ])
  browser = await launch()
  page = await browser.newPage({ viewport: { width: 1000, height: 1200 } })
  await page.route('**/*', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>' }))
  await page.goto(`${ORIGIN}/`)
  await page.addScriptTag({ path: script })
})

afterAll(async () => {
  await browser?.close()
  cleanup()
})

for (const room of [391, 320]) test(`a composite with a label at its views' right edge keeps readable views fitted to ${room} px`, async () => {
  await page.evaluate(([spec, w]) => (window as any).__t.chart(spec, w), [SPEC, room] as const)
  await page.waitForSelector(`.room-${room} [data-settled="true"] svg`, { timeout: 30_000 })
  const got = await page.evaluate((room) => {
    const svg = document.querySelector(`.room-${room} svg`) as SVGSVGElement
    // each x axis: the boxes of the tick labels it shows (Vega hides a label that would overlap at opacity 0), left to right
    const axes = Array.from(svg.querySelectorAll('g.role-axis')).filter((g) => (g.getAttribute('aria-label') ?? '').startsWith('X-axis'))
    const shown = (g: Element) => Array.from(g.querySelectorAll('g.role-axis-label text')).filter((t) => t.getAttribute('opacity') !== '0')
    const labels = axes.map((g) => shown(g).map((t) => { const r = t.getBoundingClientRect(); return { text: t.textContent, left: r.left, right: r.right } }).sort((a, b) => a.left - b.left))
    const plots = axes.map((g) => g.getBoundingClientRect().width)
    return { svg: svg.getBoundingClientRect().width, labels, plots }
  }, room)
  assert.ok(got.svg <= room + 1, `the chart is ${got.svg} px in a ${room} px room`)
  assert.equal(got.plots.length, 2)
  for (const w of got.plots) assert.ok(w >= room / 2, `a view is ${w} px wide in a ${room} px room`)
  for (const axis of got.labels) {
    assert.ok(axis.length >= 2, JSON.stringify(axis))
    for (let i = 1; i < axis.length; i++) assert.ok(axis[i].left >= axis[i - 1].right, `"${axis[i - 1].text}" runs into "${axis[i].text}"`)
  }
})
