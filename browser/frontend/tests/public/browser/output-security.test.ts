// What model- or corpus-written output can do in a real browser (components/Outputs.tsx), the half of
// tests/public/security.test.tsx that jsdom cannot show: the browser's own sandbox and layout. A scripted html output
// runs in a frame that cannot reach the page, and what it posts to the API leaves as `Origin: null`, which the backend's
// Origin check refuses; inlined html or svg cannot draw over the page.
import assert from 'node:assert/strict'
import { afterAll, beforeAll, test } from 'vitest'
import type { Browser, Page } from 'playwright'
import { readFileSync } from 'node:fs'
import { bundle, cleanup, FRONTEND, launch, ORIGIN, src } from './page.ts'

let browser: Browser
let page: Page
/** every request the page or its frames made to the app's /api, with its method and Origin */
const api: { method: string; path: string; origin: string | null }[] = []

beforeAll(async () => {
  const script = await bundle('output-security', [
    `import { createRoot } from 'react-dom/client'`,
    `import { flushSync } from 'react-dom'`,
    `import { Output } from '${src('components/Outputs.tsx')}'`,
    `const mount = (node) => { const el = document.createElement('div'); el.style.width = '640px'; el.id = 'm' + Math.random().toString(36).slice(2); document.body.appendChild(el); flushSync(() => createRoot(el).render(node)); return el.id }`,
    `window.__t = { output: (bundle) => mount(<Output bundle={bundle} />) }`,
  ])
  browser = await launch()
  page = await browser.newPage()
  await page.route('**/*', (route) => {
    const req = route.request()
    const url = new URL(req.url())
    if (url.protocol === 'data:' || url.protocol === 'blob:') return route.continue()
    if (url.origin !== ORIGIN) return route.fulfill({ status: 200, contentType: 'image/png', body: '' })
    if (url.pathname.startsWith('/api/')) {
      api.push({ method: req.method(), path: url.pathname, origin: req.headers()['origin'] ?? null })
      return route.fulfill({ status: 404, contentType: 'application/json', body: '{"detail":"not found"}' })
    }
    return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>' })
  })
  await page.goto(`${ORIGIN}/?ws=mini`)
  await page.addScriptTag({ path: script })
})

afterAll(async () => {
  await browser?.close()
  cleanup()
})

const settle = (ms = 400) => new Promise((r) => setTimeout(r, ms))
const pwned = () => page.evaluate(() => (window as any).__pwned ?? null)
const output = (bundle: Record<string, unknown>): Promise<string> => page.evaluate((b) => (window as any).__t.output(b), bundle)

test('a scripted html output runs in a frame that cannot reach the page or post to the API as the page', async () => {
  const probe = `<p>probe</p><script>(async () => {
    const out = {}
    try { out.parentDoc = String(parent.document.title) } catch (e) { out.parentDoc = 'blocked' }
    try { await parent.fetch('/api/dev/revert', { method: 'POST' }); out.parentFetch = 'called' } catch (e) { out.parentFetch = 'blocked' }
    try { parent.__pwned = 'frame'; out.parentWrite = parent.__pwned === 'frame' ? 'wrote' : 'blocked' } catch (e) { out.parentWrite = 'blocked' }
    try { await fetch('/api/dev/revert', { method: 'POST' }) } catch (e) {}
    parent.postMessage({ probe: out }, '*')
  })()</script>`
  const got = page.evaluate(() => new Promise((resolve) => addEventListener('message', (e) => e.data?.probe && resolve(e.data.probe))))
  const id = await output({ 'text/html': probe })
  assert.deepEqual(await got, { parentDoc: 'blocked', parentFetch: 'blocked', parentWrite: 'blocked' })
  assert.equal(await pwned(), null)
  assert.equal(await page.evaluate((id) => document.querySelector(`#${id} iframe`)?.getAttribute('sandbox'), id), 'allow-scripts')
  // the frame's POST left as `Origin: null`; nothing went out as the page
  const posts = api.filter((r) => r.method === 'POST' && r.path === '/api/dev/revert')
  assert.ok(posts.length >= 1)
  assert.ok(posts.every((r) => r.origin === 'null'), JSON.stringify(posts))
})

/** The outputs' stylesheet, for the output's box, until the returned function removes it (other checks count the page's
 * style elements). */
async function outputsCss(): Promise<() => Promise<void>> {
  const sheet = await page.addStyleTag({ content: readFileSync(`${FRONTEND}/src/styles/outputs.css`, 'utf8') })
  return async () => { await sheet.evaluate((node) => node.parentNode?.removeChild(node)) }
}

test('an inlined html output or an svg figure cannot draw over the page', async () => {
  const html = await output({ 'text/html': '<div class="chat-perm" style="position: fixed; inset: 0; z-index: 2147483647; background: red; transform: translate(0, 0)">cover</div>' })
  const svg = await output({
    'image/svg+xml': `<svg xmlns="http://www.w3.org/2000/svg" width="100pt" height="50pt" viewBox="0 0 100 50" overflow="visible" style="z-index: 2147483647; transform: translate(0, 0); stroke-linecap: butt">
 <rect x="-5000" y="-5000" width="10000" height="10000" fill="red"/>
</svg>`,
  })
  const done = await outputsCss()
  await settle()
  const got = await page.evaluate(([html, svg]) => {
    const fig = document.getElementById(svg)!.querySelector('svg')!
    const box = fig.parentElement!.getBoundingClientRect()
    const under = (x: number, y: number) => document.elementFromPoint(x, y)
    const inHtml = (x: number, y: number) => !!under(x, y) && document.getElementById(html)!.contains(under(x, y))
    const inSvg = (x: number, y: number) => !!under(x, y) && fig.contains(under(x, y))
    return {
      htmlCorner: inHtml(innerWidth - 2, innerHeight - 2),
      svgCorner: inSvg(innerWidth - 2, innerHeight - 2),
      svgBeside: inSvg(box.right + 20, box.top + 10),
      svgInside: inSvg(box.left + 10, box.top + 10),
    }
  }, [html, svg])
  await done()
  assert.deepEqual(got, { htmlCorner: false, svgCorner: false, svgBeside: false, svgInside: true })
})
