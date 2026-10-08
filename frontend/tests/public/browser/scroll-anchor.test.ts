// The reader's scroll anchor (src/files/anchor.ts) in headless Chromium, with the browser's own anchoring off as the
// reader turns it off (and as Safari has none): records above the view that change height (a record drawn for the
// first time replacing its estimated height), one across the top that grows from its top, and a page of records
// loaded above leave the record the analyst reads where it was on screen; a jump of the reader's own lands where it was
// sent, and the anchor goes with it.
import assert from 'node:assert/strict'
import { afterAll, beforeAll, test } from 'vitest'
import type { Browser, Page } from 'playwright'
import { bundle, cleanup, launch, ORIGIN, src } from './page.ts'

let browser: Browser
let page: Page

beforeAll(async () => {
  const script = await bundle('scroll-anchor', [
    `import { createRoot } from 'react-dom/client'`,
    `import { flushSync } from 'react-dom'`,
    `import { useRef } from 'react'`,
    `import { useScrollAnchor } from '${src('files/anchor.ts')}'`,
    `type Rec = { line: number; h: number }`,
    `let hold: () => void = () => {}`,
    `function Body({ recs }: { recs: Rec[] }) {`,
    `  const ref = useRef<HTMLDivElement | null>(null)`,
    `  hold = useScrollAnchor(ref, [recs]).hold`,
    `  return <div ref={ref} id="body" style={{ height: 400, overflow: 'auto', overflowAnchor: 'none' }}><div>{recs.map((r) => <div key={r.line} className="reader-card" data-line={r.line} style={{ height: r.h, borderBottom: '1px solid #ccc' }}>{r.line}</div>)}</div></div>`,
    `}`,
    `const root = createRoot(document.getElementById('root')!)`,
    `const w = window as any`,
    `w.__render = (recs: Rec[]) => flushSync(() => root.render(<Body recs={recs} />))`,
    `w.__hold = () => hold()`,
  ])
  const { readFileSync } = await import('node:fs')
  browser = await launch()
  page = await browser.newPage({ viewport: { width: 800, height: 600 } })
  await page.route('**/*', (route) => {
    const p = new URL(route.request().url()).pathname
    if (p === '/') return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><html><body style="margin:0"><div id="root"></div><script src="/bundle.js"></script></body></html>' })
    if (p === '/bundle.js') return route.fulfill({ status: 200, contentType: 'text/javascript', body: readFileSync(script) })
    return route.fulfill({ status: 404, body: '' })
  })
  await page.goto(`${ORIGIN}/`)
})

afterAll(async () => {
  await browser?.close()
  cleanup()
})

const frames = (n = 3) => page.evaluate((k) => new Promise<void>((r) => { const step = (i: number) => (i ? requestAnimationFrame(() => step(i - 1)) : r()); step(k) }), n)
const recs = (from: number, to: number, h = 100) => Array.from({ length: to - from + 1 }, (_, i) => ({ line: from + i, h }))
/** the top of a record on screen, px from the body's top */
const topOf = (line: number) => page.evaluate((l) => document.querySelector(`[data-line="${l}"]`)!.getBoundingClientRect().top - document.getElementById('body')!.getBoundingClientRect().top, line)

async function at(line: number) {
  await page.evaluate((l) => {
    const body = document.getElementById('body')!
    body.scrollTop += document.querySelector(`[data-line="${l}"]`)!.getBoundingClientRect().top - body.getBoundingClientRect().top
  }, line)
  await frames()
}

test('records above the view that grow or shrink leave the record at the top in place', async () => {
  await page.evaluate((r) => (window as any).__render(r), recs(1, 60))
  await frames()
  await at(30)
  assert.equal(Math.round(await topOf(30)), 0)
  // records far above take their real heights, some taller, some shorter than the estimate
  await page.evaluate(() => {
    document.querySelectorAll<HTMLElement>('[data-line]').forEach((el) => {
      const l = Number(el.dataset.line)
      if (l >= 10 && l < 20) el.style.height = '400px'
      if (l >= 20 && l < 25) el.style.height = '30px'
    })
  })
  await frames()
  assert.ok(Math.abs(await topOf(30)) <= 1, `record 30 moved to ${await topOf(30)}`)
})

test('a record across the top that grows from its top keeps what shows of it in place', async () => {
  await page.evaluate((r) => (window as any).__render(r), recs(100, 160))
  await frames()
  await at(130)
  await page.evaluate(() => (document.getElementById('body')!.scrollTop -= 40))
  await frames()
  const before = await topOf(130)
  // record 129, of which the bottom 40px show, is drawn and grows from its top
  await page.evaluate(() => ((document.querySelector('[data-line="129"]') as HTMLElement).style.height = '700px'))
  await frames()
  assert.ok(Math.abs((await topOf(130)) - before) <= 1, `record 130 moved from ${before} to ${await topOf(130)}`)
})

test('a page of records loaded above, held across its commit, leaves the record at the top in place', async () => {
  await page.evaluate((r) => (window as any).__render(r), recs(200, 260))
  await frames()
  await at(210)
  await page.evaluate(() => (window as any).__hold())
  await page.evaluate((r) => (window as any).__render(r), [...recs(150, 199, 150), ...recs(200, 260)])
  await frames()
  assert.ok(Math.abs(await topOf(210)) <= 1, `record 210 moved to ${await topOf(210)}`)
})

test('a jump of the reader lands where it was sent, and the anchor follows it there', async () => {
  await page.evaluate((r) => (window as any).__render(r), recs(300, 400))
  await frames()
  await at(310)
  await at(380)
  assert.ok(Math.abs(await topOf(380)) <= 1, `record 380 at ${await topOf(380)}`)
  // records between the old place and the new take their real heights
  await page.evaluate(() => {
    for (let l = 312; l < 330; l++) (document.querySelector(`[data-line="${l}"]`) as HTMLElement).style.height = '260px'
  })
  await frames()
  assert.ok(Math.abs(await topOf(380)) <= 1, `record 380 moved to ${await topOf(380)}`)
})
