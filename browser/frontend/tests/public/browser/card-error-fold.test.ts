// A card whose run failed, drawn by the canvas's own CardFace (canvas/bodies.tsx, components/Outputs ErrorOut) with
// thimble's stylesheets, in a real browser: on a narrow card the error stays one line, its name and its message's first
// line cut with an ellipsis, and Show traceback opens it whole, its lines wrapping in the card again.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, test } from 'vitest'
import type { Browser, Page } from 'playwright'
import { bundle, cleanup, launch, ORIGIN, src } from './page.ts'

let browser: Browser
let page: Page

const ERROR = {
  ename: 'ValueError',
  evalue: "No runs match status='flaky' among the nightly runs of the last ninety days\nThe column 'status' holds only 'pass' and 'fail'.",
  traceback: ['Traceback (most recent call last)', "Cell In[2], line 6\n----> 6 rate = failures(runs, status='flaky')"],
}

beforeAll(async () => {
  const script = await bundle(
    'card-error-fold',
    [
      `import '${src('styles/index.css')}'`,
      `import { createRoot } from 'react-dom/client'`,
      `import { CardFace } from '${src('canvas/CardFace.tsx')}'`,
      `import { CanvasContext } from '${src('canvas/context.ts')}'`,
      `import { ERROR_MIME } from '${src('components/Outputs.tsx')}'`,
      `const ctx = { ws: 'w', filters: null, keep: null, concepts: new Map(), threadOf: () => ({ chatId: null, name: '', writable: false }), unread: new Set(), refresh: () => undefined, openThread: () => undefined }`,
      `const cell = { id: 'c1', notebook: 'nb', kind: 'table', title: 'Which nightly runs failed?', created_by: 'chat:main', ts: '', takeaway: '', code: "failures(runs, status='flaky')", outputs: [{ [ERROR_MIME]: ${JSON.stringify(ERROR)} }], status: 'error' }`,
      `createRoot(document.getElementById('card')!).render(<CanvasContext.Provider value={ctx}><CardFace cell={cell} width={200} label={{ concept: null, error: null }} /></CanvasContext.Provider>)`,
    ],
    { loader: { '.css': 'css', '.woff2': 'empty', '.woff': 'empty' }, conditions: ['style'] },
  )
  const css = readFileSync(script.replace(/\.js$/, '.css'), 'utf8')
  browser = await launch()
  page = await browser.newPage({ viewport: { width: 600, height: 800 } })
  await page.route('**/*', (route) => {
    const p = new URL(route.request().url()).pathname
    if (p === '/bundle.css') return route.fulfill({ status: 200, contentType: 'text/css', body: css })
    if (p.startsWith('/api/')) return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
    return route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/bundle.css"></head><body><div id="card" class="canvas-card-box" style="width:240px;margin:16px"></div></body></html>',
    })
  })
  await page.goto(`${ORIGIN}/`)
  await page.addScriptTag({ path: script })
  await page.waitForSelector('.bcell-output .outputs-error')
})

afterAll(async () => {
  await browser?.close()
  cleanup()
})

/** The error as the card draws it: how many lines high it is, and how it is laid out. */
const error = () =>
  page.evaluate(() => {
    const pre = document.querySelector<HTMLElement>('.bcell-output .outputs-error')!
    const style = getComputedStyle(pre)
    const lines = (pre.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom)) / parseFloat(style.lineHeight)
    return { lines: Math.round(lines * 10) / 10, whiteSpace: style.whiteSpace, textOverflow: style.textOverflow, cut: pre.scrollWidth > pre.clientWidth }
  })

test("a narrow card's failed run is one line, cut with an ellipsis, and Show traceback opens it whole", async () => {
  assert.deepEqual(await error(), { lines: 1, whiteSpace: 'nowrap', textOverflow: 'ellipsis', cut: true })
  await page.click('.bcell-output button:has-text("Show traceback")')
  const open = await error()
  assert.ok(open.whiteSpace === 'pre-wrap' && open.lines > 5, `whole, its lines wrapping: ${JSON.stringify(open)}`)
})
