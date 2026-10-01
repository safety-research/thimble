// A view's own label controls (backend/app/viewer_bridge.js labelCall, src/files/labelCalls.ts) in a real browser: the
// real ViewerFrame holds a view in its sandboxed frame, and a label change the page makes on load, on a timer or by
// posting the message itself is refused, while the analyst's click in the view turns a label on and stores a mark.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, test } from 'vitest'
import type { Browser, Frame, Page } from 'playwright'
import { bundle, cleanup, FRONTEND, launch, ORIGIN, src } from './page.ts'

const BRIDGE = readFileSync(path.join(FRONTEND, '..', 'backend', 'app', 'viewer_bridge.js'), 'utf8')
const NO_GESTURE = 'thimble changes labels only while the analyst clicks or types in the view'
let browser: Browser
let page: Page
const api: { method: string; path: string; body: string | null }[] = []

// a view that tries to change labels by itself (on load, on a timer, and by posting the bridge's message with a guessed
// key) and draws its own controls, whose clicks call thimble
const VIEW = `<!doctype html><html><head><script>window.__thimbleView = {"slug":"board","name":"Board"}</script>
<script>${BRIDGE.replace(/<\/script/g, '<\\/script')}</script></head><body>
<button id="on" data-label="k1">asks</button><button id="mark">mark</button><button id="filter">filter</button><button id="edit">edit</button><button id="bad">bad value</button>
<div data-anchor="a.jsonl#L1">one</div><div data-anchor="a.jsonl#L2">two</div>
<script>
const log = (what, p) => p.then(() => parent.postMessage({ type: 'test:log', what, ok: true }, '*'), (e) => parent.postMessage({ type: 'test:log', what, ok: false, error: e.message, refused: !!e.thimbleRefused }, '*'))
log('load', thimble.setLabel('k1', true))
setTimeout(() => log('timer', thimble.setLabel('k1', false)), 1200)
setTimeout(() => log('timer-mark', thimble.mark('a.jsonl#L2', 'asks', 'yes')), 1300)
setTimeout(() => log('timer-filter', thimble.setFilter('k1', 'yes')), 1400)
setTimeout(() => parent.postMessage({ type: 'thimble:labelCall', id: 999, key: 'guess', op: 'on', args: { id: 'k1', on: true } }, '*'), 1500)
document.getElementById('on').onclick = () => log('click', thimble.setLabel('k1', true))
document.getElementById('mark').onclick = () => log('mark', thimble.mark('a.jsonl#L1', 'asks', 'yes'))
document.getElementById('filter').onclick = () => log('filter', thimble.setFilter('asks', 'yes'))
document.getElementById('edit').onclick = () => log('edit', thimble.editLabel('k1'))
document.getElementById('bad').onclick = () => log('bad', thimble.mark('a.jsonl#L1', 'asks', 'maybe'))
</script></body></html>`

beforeAll(async () => {
  const script = await bundle('view-label-calls', [
    `import { createElement } from 'react'`,
    `import { createRoot } from 'react-dom/client'`,
    `import { ViewerFrame } from '${src('files/ViewerFrame.tsx')}'`,
    `const w = window`,
    `w.__acts = []`,
    `w.__logs = []`,
    `addEventListener('message', (e) => { if (e.data && e.data.type === 'test:log') w.__logs.push(e.data) })`,
    `const k = { id: 'k1', name: 'asks', description: '', unit: 'record', kind: 'prompt', spec: '', labels: ['yes', 'no'], created_by: 'analyst', ts: '', classes: [{ name: 'yes', color: 2, highlight: true }, { name: 'no', color: 0, highlight: false }], shown: false }`,
    `const actions = { setOn: (id, on) => w.__acts.push(['on', id, on]), setColour: (id, v, c) => w.__acts.push(['colour', id, v, c]), edit: (id) => w.__acts.push(['edit', id]) }`,
    `const root = document.body.appendChild(document.createElement('div'))`,
    `root.style.cssText = 'width:600px;height:400px'`,
    `createRoot(root).render(createElement(ViewerFrame, { ws: 'w', slug: 'board', title: 'Board', byId: new Map([[k.id, k]]), labels: [], labelActions: actions, onLabelControls: (on) => w.__acts.push(['controls', on]) }))`,
  ])
  browser = await launch()
  page = await browser.newPage({ viewport: { width: 900, height: 700 } })
  await page.route('**/*', async (route) => {
    const req = route.request()
    const url = new URL(req.url())
    if (url.pathname === '/api/ws/w/views/board/frame') return route.fulfill({ status: 200, contentType: 'text/html', body: VIEW })
    if (url.pathname.startsWith('/api/')) {
      api.push({ method: req.method(), path: url.pathname, body: req.postData() })
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(url.pathname.endsWith('/labels') ? { row: {}, calibration: null } : {}) })
    }
    return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>' })
  })
  await page.goto(`${ORIGIN}/`)
  await page.addScriptTag({ path: script })
  await page.waitForFunction(() => (window as any).__logs.some((l: { what: string }) => l.what === 'load'))
})

afterAll(async () => {
  await browser?.close()
  cleanup()
})

const frame = (): Frame => page.frames().find((f) => f !== page.mainFrame())!
const logs = () => page.evaluate(() => (window as any).__logs as { what: string; ok: boolean; error?: string; refused?: boolean }[])
const acts = () => page.evaluate(() => (window as any).__acts as unknown[][])
const apiCalls = async () => api
const logOf = async (what: string) => {
  await page.waitForFunction((w) => (window as any).__logs.some((l: { what: string }) => l.what === w), what)
  return (await logs()).find((l) => l.what === what)!
}

test('a label change the page makes on load or on a timer is refused, and so is one it posts itself', async () => {
  const load = await logOf('load')
  assert.deepEqual([load.ok, load.error, load.refused], [false, NO_GESTURE, true])
  // the timers fire with no input in the frame; nothing here evaluates in the frame, which would count as a gesture
  await page.waitForTimeout(1800)
  for (const what of ['timer', 'timer-mark', 'timer-filter']) {
    const l = await logOf(what)
    assert.deepEqual([l.ok, l.error], [false, NO_GESTURE], what)
  }
  assert.deepEqual((await acts()).filter((a) => a[0] !== 'controls'), [], 'no label was turned on or off')
  assert.deepEqual((await apiCalls()).filter((c) => c.method !== 'GET'), [], 'nothing was stored and no filter set')
  assert.ok((await acts()).some((a) => a[0] === 'controls' && a[1] === true), 'the page said it draws label controls of its own')
})

test("the analyst's click in the view turns a label on, stores a mark, sets the filter and opens the editor", async () => {
  await frame().locator('#on').click()
  const click = await logOf('click')
  assert.equal(click.ok, true, click.error)
  assert.deepEqual((await acts()).filter((a) => a[0] === 'on'), [['on', 'k1', true]])

  await frame().locator('#mark').click()
  const mark = await logOf('mark')
  assert.equal(mark.ok, true, mark.error)
  const stored = (await apiCalls()).filter((c) => c.method === 'POST' && c.path === '/api/ws/w/concepts/k1/labels')
  assert.equal(stored.length, 1)
  assert.deepEqual(JSON.parse(stored[0].body ?? '{}'), { ref: 'a.jsonl#L1', label: 'yes' })

  await frame().locator('#filter').click()
  assert.equal((await logOf('filter')).ok, true)
  const put = (await apiCalls()).filter((c) => c.method === 'PUT' && c.path === '/api/ws/w/filters')
  assert.deepEqual(JSON.parse(put[0]?.body ?? '{}'), { scope: 'files', concept: 'k1', value: 'yes' })

  await frame().locator('#edit').click()
  assert.equal((await logOf('edit')).ok, true)
  assert.deepEqual((await acts()).filter((a) => a[0] === 'edit'), [['edit', 'k1']])
})

test('a call thimble cannot do comes back with its reason', async () => {
  await frame().locator('#bad').click()
  const bad = await logOf('bad')
  assert.deepEqual([bad.ok, bad.error], [false, 'asks has no value "maybe"'])
})
