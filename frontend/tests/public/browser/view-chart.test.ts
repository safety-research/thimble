// The view kit's charts (backend/app/viewer_chart.js, thimble.chart) and record viewer (viewer_record.js,
// thimble.record) in a real browser: a page in a sandboxed frame with the kit as views.frame_document loads it, the
// vega builds a view names in its libs, and the canvas's chart drawing (src/lib/kitChart.ts, bundled here as vite build
// bundles it into kit/chart.js). A chart is drawn by the canvas's own code in the page's own theme: its one series in
// --viz-1, its axis labels in --viz-font-label, on the paper; its groups in Color by's colours, as its records' bars
// are, with no legend; a label's classes in the label's colours; refitted when its box narrows; and in a box too
// narrow for its long names, the names are cut so the plot keeps its room, as on a card. A record's values line up at
// each level, a long string is folded to six lines, and nothing runs past the side panel's width. thimble's answers to
// the kit's chart fetches are given here as kernel_thimble.chart_spec writes them; that they are the card's spec is
// backend/tests_public/test_view_kit_records_charts.py, and the kit's plumbing is tests/public/records-charts-kit.test.ts.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, test } from 'vitest'
import type { Browser, Frame, Page } from 'playwright'
import { bundle, cleanup, FRONTEND, launch, src } from './page.ts'

const APP = path.join(FRONTEND, '..', 'backend', 'app')
const read = (p: string) => readFileSync(p, 'utf8')
const inline = (js: string) => `<script>${js.replace(/<\/script/gi, '<\\/script')}</script>`
const LIB = (p: string) => read(path.join(FRONTEND, 'node_modules', p))
// a face of each family the chart style names, so the drawing waits for no face (the page's are inlined in thimble)
const FACES = "@font-face{font-family:'Geist Mono';src:local('DejaVu Sans Mono'),local('Courier New')}@font-face{font-family:'Hanken Grotesk';src:local('DejaVu Sans'),local('Arial')}"

const SCHEMA = 'https://vega.github.io/schema/vega-lite/v6.json'
const tip = (fields: string[]) => fields.map((f) => ({ field: f, type: f === 'posts' ? 'quantitative' : 'nominal', title: f }))
// as kernel_thimble.chart_spec writes them
const ANSWERS: Record<string, object> = {
  one: {
    spec: { $schema: SCHEMA, data: { values: [{ agent: 'agent-1', posts: 3 }, { agent: 'agent-2', posts: 9 }] }, mark: 'bar',
      encoding: { y: { field: 'agent', type: 'nominal', title: 'agent', sort: ['agent-2', 'agent-1'] }, x: { field: 'posts', type: 'quantitative', title: 'posts' }, tooltip: tip(['agent', 'posts']) } },
    n: 2,
  },
  grouped: {
    spec: { $schema: SCHEMA, data: { values: [{ agent: 'agent-1', posts: 3, tool: 'Read' }, { agent: 'agent-2', posts: 9, tool: 'Bash' }, { agent: 'agent-2', posts: 2, tool: 'Read' }] }, mark: 'bar',
      transform: [{ calculate: 'indexof(["Bash", "Read"], datum["tool"])', as: '__thimble_stack' }],
      encoding: { y: { field: 'agent', type: 'nominal', title: 'agent', sort: ['agent-2', 'agent-1'] }, x: { field: 'posts', type: 'quantitative', title: 'posts' },
        color: { field: 'tool', type: 'nominal', title: 'tool', sort: ['Bash', 'Read'] }, order: { field: '__thimble_stack', type: 'quantitative' }, tooltip: tip(['agent', 'posts', 'tool']) } },
    n: 3,
  },
  labelled: {
    spec: { $schema: SCHEMA, data: { values: [{ activity: 'captcha', posts: 8 }, { activity: 'money', posts: 4 }, { activity: 'other', posts: 6 }] }, mark: 'bar',
      encoding: { y: { field: 'activity', type: 'nominal', title: 'activity', sort: ['captcha', 'money', 'other'] }, x: { field: 'posts', type: 'quantitative', title: 'posts' },
        color: { field: 'activity', type: 'nominal', title: 'activity', sort: ['captcha', 'money', 'other'], legend: null }, tooltip: tip(['activity', 'posts']) } },
    n: 3,
    label: [['captcha', 1], ['signup', 2], ['money', 3], ['other', 0]],
  },
  long: {
    spec: { $schema: SCHEMA, data: { values: [0, 1, 2].map((i) => ({ page: `Wikipedia:Requests for comment/the longest page name of them all, number ${i}`, posts: 3 + i })) }, mark: 'bar',
      encoding: { y: { field: 'page', type: 'nominal', title: 'page' }, x: { field: 'posts', type: 'quantitative', title: 'posts' } } },
    n: 3,
  },
}

let browser: Browser
let page: Page
let doc: string

beforeAll(async () => {
  const drawing = read(await bundle('kit-chart', [`import '${src('lib/kitChart.ts')}'`]))
  const kit =
    inline(read(path.join(APP, 'viewer_bridge.js'))) +
    inline(`window.__thimbleLabelOrder = ${read(path.join(APP, 'label_order.json'))}`) +
    ['viewer_colour.js', 'viewer_controls.js', 'viewer_side.js', 'viewer_transcript.js', 'viewer_record.js'].map((n) => inline(read(path.join(APP, n)))).join('') +
    inline(drawing) +
    ['viewer_chart.js', 'viewer_range.js'].map((n) => inline(read(path.join(APP, n)))).join('')
  const libs = ['vega/build/vega.min.js', 'vega-lite/build/vega-lite.min.js', 'vega-embed/build/vega-embed.min.js'].map((p) => inline(LIB(p))).join('')
  const tokens = read(path.join(FRONTEND, 'src', 'styles', 'tokens.css'))
  doc = `<!doctype html><html><head><style>${FACES}${tokens}</style>${kit}<style>${read(path.join(APP, 'viewer_kit.css'))}</style><style>${read(path.join(APP, 'viewer_parts.css'))}</style>${libs}
<style>body{margin:0;background:var(--surface-card)} #a,#b,#c,#d{width:600px} #n{width:320px} #rec{width:360px}</style></head><body>
<span id="colour"></span><div id="a"></div><div id="b"></div><div id="c"></div><div id="d"></div><div id="n"></div><div id="rec"></div></body></html>`
  browser = await launch()
})

afterAll(async () => {
  await browser?.close()
  cleanup()
})

/** A fresh page holding the view in a sandboxed frame, which answers the kit's chart fetches by the rows' `which`. */
async function framed(): Promise<Frame> {
  page = await browser.newPage({ viewport: { width: 800, height: 1400 } })
  await page.setContent('<!doctype html><html><body style="margin:0"><iframe id="f" sandbox="allow-scripts" style="border:0;width:780px;height:1380px"></iframe></body></html>')
  await page.evaluate(
    ([d, answers]) => {
      const f = document.getElementById('f') as HTMLIFrameElement
      addEventListener('message', (e) => {
        const m = (e.data || {}) as { type?: string; id?: number; query?: { rows?: { which?: string }[] } }
        if (m.type !== 'thimble:fetch') return
        const which = m.query?.rows?.[0]?.which ?? ''
        f.contentWindow!.postMessage({ type: 'thimble:result', id: m.id, data: (answers as Record<string, object>)[which] }, '*')
      })
      f.srcdoc = d as string
    },
    [doc, ANSWERS] as const,
  )
  await page.waitForFunction(() => (document.getElementById('f') as HTMLIFrameElement).contentWindow)
  const frame = page.frames().find((f) => f !== page.mainFrame())!
  await frame.waitForFunction(() => typeof (window as any).thimble?.chart === 'function' && !!(window as any).__thimbleCharts && !!(window as any).vegaEmbed)
  return frame
}

/** Draw a chart whose answer is ANSWERS[which], and wait for it. */
const chart = (frame: Frame, mount: string, which: string, options: Record<string, unknown> = {}) =>
  frame.evaluate(
    async ([mount, which, options]) => {
      const t = (window as any).thimble
      const opts = { ...(options as object) } as Record<string, unknown>
      if (opts.colour) opts.colour = (window as any).colour
      const view = await t.chart(mount, 'bar', [{ which }], opts)
      return !!view
    },
    [mount, which, options] as const,
  )

const fills = (frame: Frame, mount: string) =>
  frame.evaluate((m) => [...document.querySelectorAll(`${m} g.mark-rect path`)].map((p) => getComputedStyle(p).fill), mount)

test("a chart is drawn by the canvas's code in the page's own theme", async () => {
  const frame = await framed()
  assert.equal(await chart(frame, '#a', 'one'), true)
  const got = await frame.evaluate(() => {
    const css = (n: string) => getComputedStyle(document.documentElement).getPropertyValue(n).trim()
    const probe = document.createElement('i')
    document.body.appendChild(probe)
    probe.style.color = css('--viz-1')
    const series = getComputedStyle(probe).color
    const label = document.querySelector('#a g.role-axis-label text') as SVGTextElement
    return {
      series,
      fills: [...document.querySelectorAll('#a g.mark-rect path')].map((p) => getComputedStyle(p).fill),
      labelFont: label.getAttribute('font-family') ?? '',
      mono: css('--viz-font-label'),
      background: getComputedStyle(document.querySelector('#a .thimble-chart-plot svg')!).backgroundColor,
      width: document.querySelector('#a svg')!.getBoundingClientRect().width,
    }
  })
  assert.deepEqual(got.fills, [got.series, got.series], 'one series takes --viz-1, the canvas theme\'s first series colour')
  assert.equal(got.labelFont.split(',')[0].replace(/["']/g, '').trim(), got.mono.split(',')[0].replace(/["']/g, '').trim(), 'axis labels in the chart style\'s mono face')
  assert.ok(got.background === 'rgba(0, 0, 0, 0)' || got.background === 'transparent', `on the paper, not a sheet of its own: ${got.background}`)
  assert.ok(got.width > 560 && got.width <= 600, `as wide as its box: ${got.width}`)
  await page.close()
})

test("its groups take Color by's colours, as its records' bars do, and a label's classes the label's colours", async () => {
  const frame = await framed()
  await frame.evaluate(() => {
    ;(window as any).colour = (window as any).thimble.colorBy({ mount: '#colour', fields: [{ name: 'tool', title: 'Tool', values: ['Read', 'Bash'] }] })
  })
  assert.equal(await chart(frame, '#b', 'grouped', { colour: true }), true)
  const want = await frame.evaluate(() => {
    const c = (window as any).colour
    return { read: c.colourOf('Read'), bash: c.colourOf('Bash'), legends: document.querySelectorAll('#b g.role-legend').length }
  })
  assert.deepEqual(new Set(await fills(frame, '#b')), new Set([want.read, want.bash]), 'each segment in its value\'s colour of Color by')
  assert.equal(want.legends, 0, "no legend: Color by's chips are the key")
  assert.equal(await chart(frame, '#c', 'labelled'), true)
  const label = await frame.evaluate(() => {
    const css = (n: string) => {
      const i = document.createElement('i')
      document.body.appendChild(i)
      i.style.color = `var(${n})`
      return getComputedStyle(i).color
    }
    return [css('--label-1'), css('--label-3'), css('--label-none')]
  })
  assert.deepEqual(await fills(frame, '#c'), label, "captcha, money and other in the label's colours, other in its gray")
  await page.close()
})

test('it is refitted when its box narrows, and cuts long names in a narrow box so the plot keeps its room', async () => {
  const frame = await framed()
  await chart(frame, '#d', 'one')
  await frame.evaluate(() => ((document.getElementById('d') as HTMLElement).style.width = '400px'))
  await frame.waitForFunction(() => document.querySelector('#d svg')!.getBoundingClientRect().width <= 400)
  assert.equal(await chart(frame, '#n', 'long'), true)
  const got = await frame.evaluate(() => {
    const plot = document.querySelector('#n g.mark-rect')!.getBoundingClientRect()
    const labels = [...document.querySelectorAll('#n g.role-axis-label text')].map((t) => t.getBoundingClientRect().width)
    return { plot: plot.width, svg: document.querySelector('#n svg')!.getBoundingClientRect().width, widest: Math.max(...labels) }
  })
  assert.ok(got.svg <= 320, `inside its 320 px box: ${got.svg}`)
  assert.ok(got.plot >= 320 * 0.3, `the plot keeps its room: ${got.plot} px`)
  assert.ok(got.widest <= 320 * 0.35 + 4, `the names cut to fit: ${got.widest} px`)
  await page.close()
})

test("a record's values line up at each level, a long string folds to six lines, and nothing runs past its box", async () => {
  const frame = await framed()
  const got = await frame.evaluate(() => {
    const rec = { type: 'tool_use', tool: 'Read', a_much_longer_key_name: 4, input: { file_path: '/repo/pandas/core/frame.py', limit: 200 },
      output: Array.from({ length: 30 }, (_, i) => `line ${i + 1} of what came back, which is long enough to wrap in the panel`).join('\n') }
    ;(window as any).thimble.record({ mount: '#rec', value: rec, ref: 'r1/explorer.jsonl#L12' })
    const left = (sel: string) => [...document.querySelectorAll(sel)].map((e) => Math.round(e.getBoundingClientRect().left))
    const box = document.getElementById('rec')!
    const text = document.querySelector('#rec .thimble-record-text') as HTMLElement
    return {
      top: left('#rec .thimble-record-tree > .thimble-record-row > .thimble-record-val'),
      nested: left('#rec .thimble-record-kids > .thimble-record-row > .thimble-record-val'),
      folded: text.getBoundingClientRect().height / parseFloat(getComputedStyle(text).lineHeight),
      over: box.scrollWidth - box.clientWidth,
    }
  })
  assert.equal(new Set(got.top).size, 1, `the record's values start at one edge: ${got.top}`)
  assert.equal(new Set(got.nested).size, 1, `a nested value's own values start at one edge: ${got.nested}`)
  assert.ok(got.nested[0] > got.top[0] - 200, 'nested under its key')
  assert.ok(got.folded > 5.5 && got.folded < 6.5, `a long string folded to six lines: ${got.folded}`)
  assert.equal(got.over, 0, 'nothing runs past the box')
  await page.close()
})
