// A video's film in the Report pane (report/Video.tsx) in a real browser: its frame is sandboxed to scripts alone, so
// the film cannot reach the page and what it posts to the API leaves as `Origin: null`, and the player draws it through
// its bridge (backend/app/film_bridge.js), the frame at t once the film is ready and a line's start when it is chosen.
// Every request the page and its frames make is recorded, and any to another host fails the check.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, test } from 'vitest'
import type { Browser, Page } from 'playwright'
import { bundle, cleanup, FRONTEND, launch, ORIGIN, src } from './page.ts'

const BRIDGE = readFileSync(path.join(FRONTEND, '..', 'backend', 'app', 'film_bridge.js'), 'utf8')
// the film a writer could write, probing what it can reach, with the bridge ahead of it as the backend puts it
const FILM = `<!doctype html><head><script>${BRIDGE}</script></head><body><script>
  const probe = {}
  try { probe.parentDoc = String(parent.document.title) } catch (e) { probe.parentDoc = 'blocked' }
  try { parent.__pwned = 'film'; probe.parentWrite = parent.__pwned === 'film' ? 'wrote' : 'blocked' } catch (e) { probe.parentWrite = 'blocked' }
  fetch('/api/dev/revert', { method: 'POST' }).catch(() => {})
  window.seek = (t) => parent.postMessage({ probe, seeked: t }, '*')
  window.ready = Promise.resolve()
</script></body>`
const DOC = {
  renderer: 'video',
  title: 'One account did it',
  lines: [
    { id: 'l1', sentences: [{ id: 's1', text: 'All 27 deletions came from one account.', refs: [], tags: [] }] },
    { id: 'l2', sentences: [{ id: 's2', text: 'The log covers one week.', refs: [], tags: [] }] },
  ],
  film: '<!doctype html>',
  timing: { duration: 12.4, lines: [{ id: 'l1', start: 0.5, end: 5 }, { id: 'l2', start: 5, end: 11.4 }] },
}

let browser: Browser
let page: Page
/** every request the page or its frames made to the app's /api, with its method and Origin */
const api: { method: string; path: string; origin: string | null }[] = []
/** every request to another host */
const outbound: string[] = []

beforeAll(async () => {
  const script = await bundle('video-film', [
    `import { createRoot } from 'react-dom/client'`,
    `import { flushSync } from 'react-dom'`,
    `import { VideoView } from '${src('report/Video.tsx')}'`,
    `const look = { colour: () => '#888', name: () => '', rank: () => 0 }`,
    `window.__t = { mount: (doc) => { const el = document.createElement('div'); el.style.width = '960px'; document.body.appendChild(el); flushSync(() => createRoot(el).render(<VideoView ws="mini" slug="video" doc={doc} comments={[]} on={new Set()} look={look} picked={null} />)) } }`,
  ])
  browser = await launch()
  page = await browser.newPage()
  await page.route('**/*', (route) => {
    const req = route.request()
    const url = new URL(req.url())
    if (url.protocol === 'data:' || url.protocol === 'blob:') return route.continue()
    if (url.origin !== ORIGIN) {
      outbound.push(req.url())
      return route.fulfill({ status: 200, body: '' })
    }
    if (url.pathname === '/api/ws/mini/investigations/main/types/video/film') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ html: FILM }) })
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

/** The next message from the film whose `seeked` passes `want`. */
const seeked = (want: number) =>
  page.evaluate((w) => new Promise<{ probe: Record<string, string>; seeked: number }>((resolve) => addEventListener('message', (e) => e.data?.probe && e.data.seeked >= w && resolve(e.data))), want)

test("a video's film runs in a frame that cannot reach the page, and the player draws it through its bridge", async () => {
  const first = seeked(0)
  await page.evaluate((doc) => (window as any).__t.mount(doc), DOC)
  const got = await first
  assert.deepEqual(got.probe, { parentDoc: 'blocked', parentWrite: 'blocked' })
  assert.equal(got.seeked, 0)
  assert.equal(await page.evaluate(() => (window as any).__pwned ?? null), null)
  assert.equal(await page.evaluate(() => document.querySelector('iframe.wu-video-frame')?.getAttribute('sandbox')), 'allow-scripts')
  for (let i = 0; i < 40 && !api.some((r) => r.method === 'POST'); i++) await new Promise((r) => setTimeout(r, 50))
  const posts = api.filter((r) => r.method === 'POST')
  assert.ok(posts.length >= 1 && posts.every((r) => r.origin === 'null'), JSON.stringify(posts))
  // the second line chosen on the scrubber: its start drawn
  const next = seeked(1)
  await page.click('button[aria-label="Line 2"]')
  assert.equal((await next).seeked, DOC.timing.lines[1].start)
  assert.deepEqual(outbound, [])
})
