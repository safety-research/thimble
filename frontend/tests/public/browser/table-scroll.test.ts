// Scrolling Files' Table mode (src/files/Reader.tsx, views/table.tsx) in a real browser, Chromium and, where Playwright's
// WebKit starts, WebKit: a file of JSON lines, colored by a boolean field that is true on a share of the lines that
// changes along the file, with "false" turned off in Color by once the file is open, and with every value on. A value
// turned off keeps its rows, so the reader stays full: the wheel scrolls it, a drag of the overview's frame down the
// file and a trackpad's flicks after it move the first row in view only down the file, never back to rows it passed,
// and the reader stays where the drag lets go.
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, test } from 'vitest'
import { chromium, webkit, type BrowserType, type Page } from 'playwright'
import { bundle, cleanup, ORIGIN, src } from './page.ts'

const MIME: Record<string, string> = { '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff' }
let dir = ''

beforeAll(async () => {
  const script = await bundle(
    'table-scroll',
    [
      `import '${src('styles/index.css')}'`,
      `import { createRoot } from 'react-dom/client'`,
      `import { Reader } from '${src('files/Reader.tsx')}'`,
      `const TOTAL = 2700`,
      `const PATH = 'tasks.jsonl'`,
      `localStorage.setItem('thimble:ws:viewOf:' + PATH, JSON.stringify('table'))`,
      `localStorage.setItem('thimble:ws:colorBy:' + PATH, JSON.stringify({ by: 'k:flagged', picks: ['k:flagged'], off: {} }))`,
      // true on 2% to 60% of the lines of each stretch of 97, by a hash of the line
      `const hash = (i) => { let x = (i * 2654435761) >>> 0; x ^= x >>> 15; x = Math.imul(x, 2246822519) >>> 0; x ^= x >>> 13; return (x >>> 0) / 4294967296 }`,
      `const share = (i) => [0.15, 0.05, 0.6, 0.1, 0.4, 0.02, 0.3, 0.25][Math.floor(i / 97) % 8]`,
      `const flagged = (i) => hash(i) < share(i)`,
      `const rec = (i) => ({ line: i, record: { id: 'task-' + i, dataset: 'set' + Math.floor(i / 90), flagged: flagged(i), domain: i % 2 ? 'math' : 'code' }, blocks: [], meta: {} })`,
      `const page = (a, b) => { const out = []; for (let i = Math.max(1, a); i <= Math.min(TOTAL, b); i++) out.push(rec(i)); return { path: PATH, kind: 'events', total_lines: TOTAL, start: Math.max(1, a), records: out } }`,
      `let n = 0; for (let i = 1; i <= TOTAL; i++) if (flagged(i)) n++`,
      `const keys = { path: PATH, total: TOTAL, bins: 100, partial: false, bytes: [], keys: [{ key: 'flagged', values: [{ value: 'false', n: TOTAL - n }, { value: 'true', n }], more: { values: 0, n: 0 }, none: 0, at: Array.from({ length: 100 }, () => 0) }] }`,
      `const answer = (u) => {`,
      `  const p = u.pathname, s = u.searchParams`,
      `  if (p.endsWith('/source/around')) { const l = +s.get('line'); return page(l - +s.get('before'), l + +s.get('after')) }`,
      `  if (p.endsWith('/source/lines')) return { path: PATH, total_lines: TOTAL, estimated: false, indexed: 1 }`,
      `  if (p.endsWith('/source/keys')) return keys`,
      `  if (p.endsWith('/source')) { const a = +s.get('start'); return page(a, a + +s.get('count') - 1) }`,
      `  return null`,
      `}`,
      `;(window as any).fetch = async (url) => {`,
      `  const got = answer(new URL(String(url), location.origin))`,
      `  await new Promise((r) => setTimeout(r, 40))`,
      `  if (got == null) return new Response(JSON.stringify({ detail: 'not here' }), { status: 404, headers: { 'content-type': 'application/json' } })`,
      `  return new Response(JSON.stringify(got), { status: 200, headers: { 'content-type': 'application/json' } })`,
      `}`,
      `const labels = { all: [], on: [], focus: null, setFocus() {}, byId: new Map(), presence: new Map(), toggle() {}, setClasses() {}, setColour() {}, save: async () => ({}), remove: async () => {} }`,
      `createRoot(document.getElementById('root')!).render(<div style={{ height: 640, display: 'flex' }}><div className="files-main"><Reader workspace="ws" path={PATH} kind="events" labels={labels} lead={null} /></div></div>)`,
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

const ENGINES: [string, BrowserType][] = [
  ['chromium', chromium],
  ['webkit', webkit],
]

async function open(page: Page, query: string) {
  await page.route('**/*', (route) => {
    const p = new URL(route.request().url()).pathname
    if (p === '/') return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><html lang="en"><head><meta charset="utf-8"><link rel="stylesheet" href="/bundle.css"></head><body style="margin:0"><div id="root"></div><script src="/bundle.js"></script></body></html>' })
    const file = path.join(dir, p)
    if (existsSync(file)) return route.fulfill({ status: 200, contentType: MIME[path.extname(file)] ?? 'application/octet-stream', body: readFileSync(file) })
    return route.fulfill({ status: 404, body: '' })
  })
  await page.goto(`${ORIGIN}/${query}`)
  await page.waitForSelector('.reader-table-row.has-cb', { timeout: 20000 })
  await page.waitForTimeout(300)
}

/** The line of the first row whose bottom is below the reader's top, null when none is. */
const firstInView = (page: Page) =>
  page.evaluate(() => {
    const body = document.querySelector<HTMLElement>('.reader-body')!
    const top = body.getBoundingClientRect().top
    const row = [...body.querySelectorAll<HTMLElement>('.reader-table-row[data-line]')].find((r) => r.getBoundingClientRect().bottom > top + 1)
    return row ? Number(row.dataset.line) : null
  })

/** The first row in view every frame while `act` runs and a moment after, each change once. */
async function watch(page: Page, act: () => Promise<void>): Promise<(number | null)[]> {
  const seen: (number | null)[] = []
  let going = true
  const loop = (async () => {
    while (going) {
      const l = await firstInView(page)
      if (!seen.length || seen[seen.length - 1] !== l) seen.push(l)
      await page.waitForTimeout(16)
    }
  })()
  await act()
  await page.waitForTimeout(500)
  going = false
  await loop
  const l = await firstInView(page)
  if (seen[seen.length - 1] !== l) seen.push(l)
  return seen
}

/** `lines` only ever go down the file, a row in view at each. */
function onward(lines: (number | null)[], what: string) {
  assert.ok(lines.every((l) => l != null), `${what}: a row is in view at each step: ${lines.join(' ')}`)
  const back = lines.findIndex((l, i) => i > 0 && l! < lines[i - 1]!)
  assert.equal(back, -1, `${what}: the first row in view went back from line ${lines[back - 1]} to ${lines[back]}: ${lines.join(' ')}`)
}

for (const [name, engine] of ENGINES)
  for (const off of [true, false])
    test(`${name}: Files' Table mode with ${off ? '"false" turned off in Color by' : 'every value on'} scrolls down the file by the wheel, a drag of the overview's frame and flicks, its first row in view never going back`, async (ctx) => {
      const browser = await engine.launch({ headless: true }).catch(() => null)
      if (!browser) return ctx.skip()
      try {
        const page = await browser.newPage({ viewport: { width: 1000, height: 700 } })
        await open(page, '')
        if (off) {
          await page.locator('.reader-colorbar .colorby-chip[data-value="false"]').click()
          await page.waitForTimeout(500)
        }
        const box = (await page.locator('.reader-body').boundingBox())!
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
        const wheel = await watch(page, async () => {
          for (let i = 0; i < 10; i++) {
            await page.mouse.wheel(0, 100)
            await page.waitForTimeout(30)
          }
        })
        onward(wheel, 'the wheel')
        assert.ok(wheel[wheel.length - 1]! > 20, `the wheel scrolls the table: ${wheel.join(' ')}`)
        // the overview's frame dragged down the file and let go
        const fr = (await page.locator('.track-frame-over').boundingBox())!
        const x = fr.x + fr.width / 2
        const y = fr.y + fr.height / 2
        const drag = await watch(page, async () => {
          await page.mouse.move(x, y)
          await page.mouse.down()
          for (let i = 1; i <= 20; i++) {
            await page.mouse.move(x, y + i * 3)
            await page.waitForTimeout(40)
          }
          await page.mouse.up()
        })
        onward(drag, 'the drag')
        assert.ok(drag[drag.length - 1]! > 150, `the drag goes down the file: ${drag.join(' ')}`)
        // a trackpad's flicks: quick wheel steps that die away
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
        const flicks = await watch(page, async () => {
          for (let k = 0; k < 4; k++)
            for (let i = 0; i < 30; i++) {
              await page.mouse.wheel(0, Math.max(2, 60 * Math.exp(-i / 8)))
              await page.waitForTimeout(16)
            }
        })
        onward(flicks, 'the flicks')
        assert.ok(flicks[flicks.length - 1]! > flicks[0]!, `the flicks scroll on: ${flicks.join(' ')}`)
      } finally {
        await browser.close()
      }
    }, 120_000)
