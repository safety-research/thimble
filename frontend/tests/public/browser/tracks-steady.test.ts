// Files' reader (src/files/Reader.tsx) and its tracks (src/files/Tracks.tsx) while it scrolls a transcript, in
// Chromium and, where Playwright's WebKit starts, in WebKit: a file of 300 messages with Color by on, whose posts are of
// many heights and with runs of records the Transcript mode hides, so that what the reader shows of the file at once
// changes many times over as it scrolls. The zoomed track neither comes nor goes while the reader scrolls (each change
// of it was a change of the reader's width, which reflowed the records and moved the reader back), the reader's width
// stays the same, and a steady wheel scroll down never moves the reader up, nor one up moves it down.
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, test } from 'vitest'
import { chromium, webkit, type BrowserType } from 'playwright'
import { bundle, cleanup, ORIGIN, src } from './page.ts'

const MIME: Record<string, string> = { '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff' }
let dir = ''

beforeAll(async () => {
  const script = await bundle(
    'tracks-steady',
    [
      `import '${src('styles/index.css')}'`,
      `import { createRoot } from 'react-dom/client'`,
      `import { Reader } from '${src('files/Reader.tsx')}'`,
      `const TOTAL = 300`,
      `localStorage.setItem('thimble:ws:viewOf:t.jsonl', JSON.stringify('transcript'))`,
      // lines 62 to 109 of every 120 have no body, which the Transcript mode hides: one post then stands for 50 lines
      `const hidden = (i) => i % 120 > 61 && i % 120 < 110`,
      `const who = (i) => ['user', 'assistant', 'tool'][i % 3]`,
      `const said = (i) => (hidden(i) ? '' : 'message ' + i + ' ' + 'lorem ipsum dolor sit amet consectetur '.repeat(1 + ((i * 7) % 13) * (i % 5 ? 1 : 3)))`,
      `const rec = (i) => ({ line: i, record: { time: '2026-06-18T20:' + String(i % 60).padStart(2, '0') + ':00Z', speaker: who(i), text: said(i) }, blocks: [{ kind: 'text', text: said(i) }], meta: {} })`,
      `const hint = { transcript: { format: 'messages', score: 0.95, keys: { speaker: 'speaker', text: 'text', time: 'time' } } }`,
      `const page = (a, b) => { const out = []; for (let i = Math.max(1, a); i <= Math.min(TOTAL, b); i++) out.push(rec(i)); return { path: 't.jsonl', kind: 'text', total_lines: TOTAL, start: Math.max(1, a), records: out, ...hint } }`,
      `const keys = { path: 't.jsonl', total: TOTAL, bins: 1000, partial: false, bytes: [], keys: [{ key: 'speaker', values: ['user', 'assistant', 'tool'].map((value) => ({ value, n: TOTAL / 3 })), more: { values: 0, n: 0 }, none: 0, at: Array.from({ length: 1000 }, (_, b) => Math.floor((b * TOTAL) / 1000) % 3) }] }`,
      `const answer = (u) => {`,
      `  const p = u.pathname, s = u.searchParams`,
      `  if (p.endsWith('/source/around')) { const l = +s.get('line'); return page(l - +s.get('before'), l + +s.get('after')) }`,
      `  if (p.endsWith('/source/lines')) return { path: 't.jsonl', total_lines: TOTAL, estimated: false, indexed: 1 }`,
      `  if (p.endsWith('/source/keys')) return keys`,
      `  if (p.endsWith('/source')) { const a = +s.get('start'); return page(a, a + +s.get('count') - 1) }`,
      `  return null`,
      `}`,
      `;(window as any).fetch = async (url) => {`,
      `  const got = answer(new URL(String(url), location.origin))`,
      `  await new Promise((r) => setTimeout(r, 20))`,
      `  if (got == null) return new Response(JSON.stringify({ detail: 'not here' }), { status: 404, headers: { 'content-type': 'application/json' } })`,
      `  return new Response(JSON.stringify(got), { status: 200, headers: { 'content-type': 'application/json' } })`,
      `}`,
      `const labels = { all: [], on: [], focus: null, setFocus() {}, byId: new Map(), presence: new Map(), toggle() {}, setClasses() {}, setColour() {}, save: async () => ({}), remove: async () => {} }`,
      `createRoot(document.getElementById('root')!).render(<div style={{ height: 700, display: 'flex' }}><div className="files-main"><Reader workspace="ws" path="t.jsonl" kind="text" labels={labels} lead={null} /></div></div>)`,
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

/** The engines: Chromium, and WebKit where Playwright's WebKit is installed and starts (CI installs Chromium alone). */
const ENGINES: [string, BrowserType][] = [
  ['chromium', chromium],
  ['webkit', webkit],
]

type Sample = { st: number; zoom: boolean; width: number; line: number }

for (const [name, engine] of ENGINES)
  test(`${name}: the zoomed track stays as it is while the reader scrolls a transcript, which never moves back`, async (ctx) => {
    const browser = await engine.launch({ headless: true }).catch(() => null)
    if (!browser) return ctx.skip()
    try {
      const page = await browser.newPage({ viewport: { width: 1000, height: 760 }, deviceScaleFactor: 2 })
      await page.route('**/*', (route) => {
        const p = new URL(route.request().url()).pathname
        if (p === '/') return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><html lang="en"><head><meta charset="utf-8"><link rel="stylesheet" href="/bundle.css"></head><body style="margin:0"><div id="root"></div><script src="/bundle.js"></script></body></html>' })
        const file = path.join(dir, p)
        if (existsSync(file)) return route.fulfill({ status: 200, contentType: MIME[path.extname(file)] ?? 'application/octet-stream', body: readFileSync(file) })
        return route.fulfill({ status: 404, body: '' })
      })
      await page.goto(`${ORIGIN}/`)
      await page.waitForSelector('.reader-card', { timeout: 20000 })
      await page.waitForSelector('.reader-colorbar')
      await page.waitForTimeout(600)
      const box = (await page.locator('.reader-body').boundingBox())!
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
      // after every painted frame: the body's scroll, whether the zoomed track shows, the body's width and its top post
      await page.evaluate(() => {
        const w = window as any
        w.__samples = []
        w.__on = true
        const body = document.querySelector('.reader-body') as HTMLElement
        const tick = () => {
          const z = document.querySelector('.track-zoom')
          const top = body.getBoundingClientRect().top
          const card = Array.from(body.querySelectorAll<HTMLElement>('.reader-card[data-line]')).find((el) => el.getBoundingClientRect().bottom > top + 1)
          w.__samples.push({ st: body.scrollTop, zoom: !!z && getComputedStyle(z).display !== 'none', width: body.clientWidth, line: Number(card?.dataset.line ?? 0) })
          if (w.__on) requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick)
      })
      const take = () =>
        page.evaluate(() => {
          const w = window as any
          const out = w.__samples
          w.__samples = []
          return out as Sample[]
        })
      await take()
      for (let i = 0; i < 300; i++) {
        await page.mouse.wheel(0, 50)
        await page.waitForTimeout(10)
      }
      await page.waitForTimeout(300)
      const down = await take()
      for (let i = 0; i < 300; i++) {
        await page.mouse.wheel(0, -60)
        await page.waitForTimeout(10)
      }
      await page.waitForTimeout(300)
      const up = await take()
      await page.evaluate(() => ((window as any).__on = false))
      const lines = down.map((s) => s.line)
      // the scroll went through the runs of hidden records, where one post stands for 50 lines, and back
      assert.ok(Math.max(...lines) > 230 && Math.min(...up.map((s) => s.line)) < 40, `the scroll went from ${Math.min(...lines)} to ${Math.max(...lines)} and back to ${Math.min(...up.map((s) => s.line))}`)
      for (const [dir, run] of [['down', down], ['up', up]] as const) {
        const zooms = new Set(run.map((s) => s.zoom))
        assert.equal(zooms.size, 1, `scrolling ${dir}, the zoomed track came and went: ${run.filter((s, i) => i && s.zoom !== run[i - 1].zoom).map((s) => `${s.zoom ? 'on' : 'off'} at ${s.line}`).join(', ')}`)
        const widths = new Set(run.map((s) => s.width))
        assert.equal(widths.size, 1, `scrolling ${dir}, the reader's width changed: ${[...widths].join(', ')}`)
        const back = run.filter((s, i) => i && (dir === 'down' ? s.st < run[i - 1].st - 0.5 : s.st > run[i - 1].st + 0.5)).map((s) => `at ${s.line}`)
        assert.deepEqual(back, [], `scrolling ${dir}, the reader moved back`)
      }
    } finally {
      await browser.close()
    }
  }, 180_000)
