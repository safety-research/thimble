// thimble.chart's charts and thimble.diagram on a card (components/Outputs, canvas/DataViz), drawn in a real browser with
// thimble's stylesheets on the light paper and the dark one, as the QA pass of 0.7.0 found them: a dots chart's groups
// at one time on one row blended into a dark dot its legend does not show; every chart with names down its y axis
// logged Vega-Lite's "Dropping fit-y" warning, and a histogram with a mark a format conflict; a time axis over nine days
// named every day while the dates had one digit and every other day after; a loop's numbered circle sat on a label.
// Now every dot keeps its own color, the canvas logs nothing, a time axis names its days at one step and the circle
// sits clear on its own edge.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, test } from 'vitest'
import type { Browser, Page } from 'playwright'
import { bundle, cleanup, launch, ORIGIN, src } from './page.ts'

const VL = 'https://vega.github.io/schema/vega-lite/v6.json'
const field = (name: string, type: string, more: Record<string, unknown> = {}) => ({ field: name, type, title: name, ...more })

// the specs as thimble.chart writes them (backend kernel_thimble), on made-up rows
const AGENTS = ['agent-1', 'agent-2', 'agent-3', 'agent-4']
const ACTIONS = ['claim', 'review', 'merge']
// each row's claim and review at the same minute, its merge five minutes after
const DOTS = AGENTS.flatMap((agent, a) =>
  [0, 20, 45].flatMap((m) => {
    const at = (k: number) => `2026-08-30T15:${String(m + a * 3 + k).padStart(2, '0')}:00`
    return [
      { time: at(0), agent, action: 'claim' },
      { time: at(0), agent, action: 'review' },
      { time: at(5), agent, action: 'merge' },
    ]
  }),
)
const dots = {
  $schema: VL,
  data: { values: DOTS },
  mark: 'point',
  encoding: {
    x: field('time', 'temporal'),
    y: field('agent', 'nominal', { sort: AGENTS }),
    color: field('action', 'nominal', { sort: ACTIONS }),
    yOffset: { field: 'action', type: 'nominal', sort: ACTIONS },
  },
}
const names = Array.from({ length: 8 }, (_, i) => ({ agent: `agent-${i + 1}`, PRs: 20 - i }))
const bars = { $schema: VL, data: { values: names }, mark: 'bar', encoding: { y: field('agent', 'nominal', { sort: names.map((r) => r.agent) }), x: field('PRs', 'quantitative') } }
const BINS = [25, 65, 68, 40, 43, 26, 11, 5].map((count, i) => ({ minutes: i * 20, 'minutes end': i * 20 + 20, count }))
const MEDIAN = [{ minutes: 57, mark: 'median 57 min' }]
const histogram = {
  $schema: VL,
  data: { values: BINS },
  layer: [
    { mark: 'bar', encoding: { x: field('minutes', 'quantitative', { bin: { binned: true, step: 20 }, axis: { format: ',~r' } }), x2: { field: 'minutes end' }, y: field('count', 'quantitative') } },
    { data: { values: MEDIAN }, mark: 'rule', encoding: { x: field('minutes', 'quantitative') } },
    { data: { values: MEDIAN }, mark: { type: 'text', align: 'left', baseline: 'top', dx: 4, dy: 4 }, encoding: { x: field('minutes', 'quantitative'), y: { value: 0 }, text: { field: 'mark', type: 'nominal' } } },
  ],
}
// ten days, Aug 3 to Aug 12: one-digit dates, then two-digit ones that need more room
const DAYS = Array.from({ length: 10 }, (_, i) => ({ day: `2026-08-${String(i + 3).padStart(2, '0')}T00:00:00`, opened: [3, 16, 8, 17, 7, 18, 4, 15, 5, 4][i] }))
const days = { $schema: VL, data: { values: DAYS }, mark: { type: 'line', point: true }, encoding: { x: field('day', 'temporal'), y: field('opened', 'quantitative') } }
// a pull request's life with a loop, its long label a numbered note
const LOOP = {
  nodes: ['open', 'reviewed', 'changes asked', 'merged'].map((id) => ({ id })),
  edges: [
    { source: 'open', target: 'reviewed', label: 'reviewed' },
    { source: 'reviewed', target: 'changes asked', label: 'asked for changes' },
    { source: 'changes asked', target: 'reviewed', label: 'fixed and sent back for another round of review' },
    { source: 'reviewed', target: 'merged', label: 'merged' },
  ],
}

let browser: Browser
let script = ''
let css = ''

beforeAll(async () => {
  script = await bundle(
    'chart-clean',
    [
      `import '${src('styles/index.css')}'`,
      `import { createRoot } from 'react-dom/client'`,
      `import { flushSync } from 'react-dom'`,
      `import { Output } from '${src('components/Outputs.tsx')}'`,
      `import { Diagram } from '${src('canvas/DataViz.tsx')}'`,
      `const box = (id, width) => { const el = document.createElement('div'); el.id = id; el.style.width = width + 'px'; document.body.appendChild(el); return createRoot(el) }`,
      `window.__t = {`,
      `  chart: (id, spec, width) => flushSync(() => box(id, width).render(<Output bundle={{ 'application/vnd.vegalite.v6+json': spec }} fitWidth={width} card />)),`,
      `  diagram: (id, dataset, width) => flushSync(() => box(id, width).render(<Diagram dataset={dataset} fitWidth={width} />)),`,
      `}`,
    ],
    { loader: { '.css': 'css', '.woff2': 'empty', '.woff': 'empty' }, conditions: ['style'] },
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
      page = await browser.newPage({ viewport: { width: 1000, height: 1200 } })
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

    const draw = async (id: string, spec: unknown, width: number) => {
      await page.evaluate(([id, spec, w]) => (window as any).__t.chart(id, spec, w), [id, spec, width] as const)
      await page.waitForSelector(`#${id} [data-settled="true"] svg`, { timeout: 30_000 })
    }

    test('the paper is the one asked for', async () => {
      assert.equal(await page.evaluate(() => document.documentElement.getAttribute('data-paper')), paper)
    })

    test("a dots chart's groups at one time on one row stand side by side, each dot in its own color", async () => {
      await draw('dots', dots, 560)
      const got = await page.evaluate(() =>
        Array.from(document.querySelectorAll('#dots g.mark-symbol.role-mark path')).map((p) => {
          const r = p.getBoundingClientRect()
          return { x: r.left + r.width / 2, y: r.top + r.height / 2, d: r.width, fill: p.getAttribute('fill') }
        }),
      )
      assert.equal(got.length, DOTS.length)
      assert.equal(new Set(got.map((g) => g.fill)).size, ACTIONS.length)
      // two dots of different colors never overlap: the claim and the review at one minute are a dot's width apart or more
      for (const a of got)
        for (const b of got)
          if (a.fill !== b.fill) assert.ok(Math.hypot(a.x - b.x, a.y - b.y) >= a.d, `dots of ${a.fill} and ${b.fill} overlap at ${a.x}, ${a.y}`)
    })

    test('a chart with names down its y axis, the dots chart and a histogram with a mark log nothing', async () => {
      await draw('names', bars, 560)
      await draw('histogram', histogram, 560)
      assert.deepEqual(logged, [])
    })

    test('a time axis over ten days names its days at one step, whatever the width', async () => {
      for (const width of [360, 400, 440, 480, 520, 560, 640]) {
        await draw(`days-${width}`, days, width)
        const shown = await page.evaluate((id) => {
          const axis = Array.from(document.querySelectorAll(`#${id} g.role-axis`)).find((g) => (g.getAttribute('aria-label') ?? '').startsWith('X-axis'))!
          return Array.from(axis.querySelectorAll('g.role-axis-label text'))
            .filter((t) => t.getAttribute('opacity') !== '0')
            .map((t) => ({ text: t.textContent ?? '', left: t.getBoundingClientRect().left }))
            .sort((a, b) => a.left - b.left)
            .map((t) => t.text)
        }, `days-${width}`)
        const dates = shown.map((t) => Number(/Aug (\d+)/.exec(t)?.[1]))
        assert.ok(dates.length >= 3 && dates.every(Number.isFinite), `${width} px: ${shown.join(', ')}`)
        const steps = new Set(dates.slice(1).map((d, i) => d - dates[i]))
        assert.equal(steps.size, 1, `${width} px names ${shown.join(', ')}`)
      }
      assert.deepEqual(logged, [])
    })

    test("a loop's numbered circle sits on its own edge, clear of the labels and the nodes", async () => {
      for (const width of [260, 400, 600]) {
        const id = `loop-${width}`
        await page.evaluate(([id, ds, w]) => (window as any).__t.diagram(id, ds, w), [id, LOOP, width] as const)
        await page.waitForSelector(`#${id} [data-settled="true"] svg`)
        const got = await page.evaluate((id) => {
          const boxes = (sel: string) => Array.from(document.querySelectorAll(`#${id} ${sel}`)).map((e) => e.getBoundingClientRect().toJSON() as DOMRect)
          return { circles: boxes('.canvas-diagram-mark circle'), labels: boxes('.canvas-diagram-label-bg'), nodes: boxes('.canvas-diagram-node rect') }
        }, id)
        assert.ok(got.circles.length >= 1, `${width} px: no numbered circle`)
        const hits = (a: DOMRect, b: DOMRect) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom
        for (const c of got.circles) {
          for (const l of got.labels) assert.ok(!hits(c, l), `${width} px: a circle at ${c.left}, ${c.top} covers a label`)
          for (const n of got.nodes) assert.ok(!hits(c, n), `${width} px: a circle at ${c.left}, ${c.top} covers a node`)
          for (const o of got.circles) assert.ok(o === c || !hits(c, o), `${width} px: two circles overlap`)
        }
      }
    })
  })
