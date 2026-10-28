// A custom card's page measures itself in a real browser (src/canvas/DataViz.tsx CustomFrame, SIZER): a page that lays
// out wider than its frame says its own width and the frame's once (onWide), and a page taller than the canvas shows
// at rest says its height once (onTall), which the board sends to the server for the card's author (backend
// card_size). A page that fits says neither.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, test } from 'vitest'
import type { Browser, Page } from 'playwright'
import { bundle, cleanup, launch, ORIGIN, src } from './page.ts'

let browser: Browser
let page: Page

const WIDE = "<table style='width:1180px'><tr><td>run 1</td><td>passed</td></tr></table>"
const TALL = '<p>every run</p>'.repeat(60)
const FITS = '<p>2 of 56 runs failed</p>'

beforeAll(async () => {
  const script = await bundle('card-size', [
    `import '${src('styles/index.css')}'`,
    `import { createRoot } from 'react-dom/client'`,
    `import { CustomFrame } from '${src('canvas/DataViz.tsx')}'`,
    `const heard: Record<string, unknown[]> = { wide: [], tall: [], fits: [] }`,
    `;(window as any).heard = heard`,
    `const frame = (name: string, html: string) => <div style={{ width: 700 }}><CustomFrame html={html} title={name} onTall={(h) => heard[name].push(['tall', h])} onWide={(w, f) => heard[name].push(['wide', w, f])} /></div>`,
    `createRoot(document.getElementById('root')!).render(<>{frame('wide', ${JSON.stringify(WIDE)})}{frame('tall', ${JSON.stringify(TALL)})}{frame('fits', ${JSON.stringify(FITS)})}</>)`,
  ], { loader: { '.css': 'css', '.woff2': 'empty', '.woff': 'empty' }, conditions: ['style'] })
  const css = readFileSync(script.replace(/\.js$/, '.css'), 'utf8')
  browser = await launch()
  page = await browser.newPage({ viewport: { width: 900, height: 900 } })
  await page.route('**/*', (route) => {
    const p = new URL(route.request().url()).pathname
    if (p === '/bundle.css') return route.fulfill({ status: 200, contentType: 'text/css', body: css })
    if (p.startsWith('/api/')) return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
    return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/bundle.css"></head><body><div id="root"></div></body></html>' })
  })
  await page.goto(`${ORIGIN}/`)
  await page.addScriptTag({ path: script })
  await page.waitForFunction(() => document.querySelectorAll('.canvas-card-frame[data-settled="true"]').length === 3)
  await page.waitForTimeout(300)
})

afterAll(async () => {
  await browser?.close()
  cleanup()
})

const heard = () => page.evaluate(() => (window as unknown as { heard: Record<string, unknown[][]> }).heard)

test("a page wider than its frame says its width and the frame's, once; a tall page its height, once; a page that fits, nothing", async () => {
  const h = await heard()
  assert.equal(h.wide.length, 1, JSON.stringify(h.wide))
  const [kind, width, frame] = h.wide[0] as [string, number, number]
  assert.equal(kind, 'wide')
  assert.equal(frame, 700)
  assert.ok(width >= 1180 && width < 1260, `the page lays out ${width} px wide`)
  assert.equal(h.tall.length, 1, JSON.stringify(h.tall))
  assert.ok((h.tall[0][1] as number) > 800, `the tall page says ${h.tall[0][1]} px`)
  assert.deepEqual(h.fits, [])
})
