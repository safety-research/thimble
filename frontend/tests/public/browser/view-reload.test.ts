// A view's Reload (src/files/viewVersion.tsx usePinnedView, through the real ViewerFrame and the kit's bridge and side
// panel, backend/app/viewer_bridge.js pageState and viewer_side.js): the newer version opens on the record the side
// panel showed, and on none once the analyst closed the panel, even when the view was opened at that record. ViewPane
// builds a new ViewerFrame for the newer version with what the old page said (`restore`); here the frame is built again
// the same way.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, test } from 'vitest'
import type { Browser, Page } from 'playwright'
import { bundle, cleanup, FRONTEND, launch, ORIGIN, src } from './page.ts'

const APP = path.join(FRONTEND, '..', 'backend', 'app')
const read = (name: string) => readFileSync(path.join(APP, name), 'utf8')
const inline = (js: string) => js.replace(/<\/script/g, '<\\/script')
// the kit as views.frame_document loads it
const KIT =
  `<script>${inline(read('viewer_bridge.js'))}</script><script>window.__thimbleLabelOrder = ${read('label_order.json')}</script>` +
  ['viewer_colour.js', 'viewer_controls.js', 'viewer_side.js', 'viewer_range.js'].map((n) => `<script>${inline(read(n))}</script>`).join('')

// twenty notes in a list; a click or a citation opens one in the side panel, and the page notes each `open` it hears
const VIEW = `<!doctype html><html><head>${KIT}<style>.thimble-side[hidden]{display:none}</style></head><body>
<div id="body"><div id="list">${Array.from({ length: 20 }, (_, i) => `<div class="row" data-anchor="notes.jsonl#L${i + 1}">note ${i + 1}</div>`).join('')}</div></div>
<script>
window.opens = []
window.side = thimble.side({ mount: '#body' })
const show = (ref) => side.open({ title: ref, ref, html: '<p>' + ref + '</p>' })
document.getElementById('list').addEventListener('click', (e) => { const r = e.target.closest('.row'); if (r) show(r.dataset.anchor) })
thimble.onOpen((o) => { opens.push(o.ref); if (o.ref) show(o.ref) })
</script></body></html>`

let browser: Browser
let page: Page

beforeAll(async () => {
  const script = await bundle('view-reload', [
    `import { createElement, createRef } from 'react'`,
    `import { createRoot } from 'react-dom/client'`,
    `import { ViewerFrame } from '${src('files/ViewerFrame.tsx')}'`,
    `const root = createRoot(document.body.appendChild(document.createElement('div')))`,
    `const handle = createRef()`,
    `let n = 0`,
    // a view opened at the citation `target`, built again (a newer version) with what the page before said
    `;(window as any).__mount = (target, restore) => root.render(createElement('div', { key: ++n, style: { width: '800px', height: '400px' } }, createElement(ViewerFrame, { ws: 'w', slug: 'notes', title: 'Notes', labels: [], targetRef: target, restore, handle })))`,
    `;(window as any).__state = () => handle.current.state()`,
  ])
  browser = await launch()
  page = await browser.newPage({ viewport: { width: 900, height: 600 } })
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === '/api/ws/w/views/notes/frame') return route.fulfill({ status: 200, contentType: 'text/html', body: VIEW })
    if (url.pathname === '/api/ws/w/views/notes/resolve') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ref: url.searchParams.get('ref') }) })
    if (url.pathname.startsWith('/api/')) return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
    return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>' })
  })
  await page.goto(`${ORIGIN}/`)
  await page.addStyleTag({ content: 'iframe{width:800px;height:400px;border:0}' })
  await page.addScriptTag({ path: script })
})

afterAll(async () => {
  await browser?.close()
  cleanup()
})

const frame = () => page.frames().find((f) => f !== page.mainFrame())!
/** the frame built for `target` with `restore`, once its page has heard its first `open` */
async function mount(target: string, restore: unknown = null) {
  await page.evaluate(([t, r]) => (window as any).__mount(t, r), [target, restore] as const)
  await page.waitForTimeout(400)
  await frame().waitForFunction(() => (window as any).opens?.length > 0)
  await page.waitForTimeout(100)
}
const panel = () => frame().evaluate(() => ({ open: (window as any).side.isOpen, ref: (window as any).side.ref, opens: (window as any).opens }))

test('Reload after the analyst closed the side panel opens the view on no record, even one opened at a citation; with the panel open it opens on its record', async () => {
  const CITED = 'notes.jsonl#L3'
  await mount(CITED)
  assert.deepEqual(await panel(), { open: true, ref: CITED, opens: [CITED] })
  // the analyst closes the panel with its ×: what Reload restores names no record
  await frame().locator('.thimble-side-close').click()
  const closed = await page.evaluate(() => (window as any).__state())
  assert.equal(closed.ref, null, JSON.stringify(closed))
  assert.equal(closed.closed, true)
  // the newer version opens with the panel closed, its `open` naming no record
  await mount(CITED, closed)
  assert.deepEqual(await panel(), { open: false, ref: null, opens: [null] })
  // a record picked in the list: Reload opens on it
  await frame().locator('.row').nth(6).click()
  const picked = await page.evaluate(() => (window as any).__state())
  assert.deepEqual([picked.ref, picked.closed], ['notes.jsonl#L7', false])
  await mount(CITED, picked)
  assert.deepEqual(await panel(), { open: true, ref: 'notes.jsonl#L7', opens: ['notes.jsonl#L7'] })
  // closed with Escape in the panel this time, then built again: no record again
  await frame().locator('.thimble-side-close').press('Escape')
  await mount(CITED, await page.evaluate(() => (window as any).__state()))
  assert.deepEqual(await panel(), { open: false, ref: null, opens: [null] })
})
