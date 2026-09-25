// The Labels pane beside a custom view (src/files/FilesTab.tsx, LabelsPane.tsx, ViewPane.tsx): the Files pane mounted
// whole in a headless Chromium page against routed API answers. A view picked in the views bar keeps the one Labels
// pane in a sidebar of its own, so a label is turned on and off without going back to the File browser, over the same
// labels the File browser shows (a label is on from the start, so the view's sidebar shows by itself); the sidebar hides
// and comes back on its own, and a label's edit card opens beside it.
import assert from 'node:assert/strict'
import { afterAll, beforeAll, test } from 'vitest'
import { addStyles, bundle, cleanup, launch, src } from './page.ts'

let script: string

let browser: any, page: any
const pageErrors: any[] = []
const sent: any[] = []

const C = (name: any, color: any, highlight: any) => ({ name, color, highlight })
const label = (id: any, name: any, color: any, shown: any) => ({ id, name, description: '', unit: 'record', marks: 'record', kind: 'regex', spec: 'x', labels: [name, `no ${name}`], classes: [C(name, color, true), C(`no ${name}`, 0, false)], created_by: 'user', ts: '2026-09-24T10:00:00Z', shown, glob: '*.jsonl' })
// what the routes hold; a PUT changes it, so the concepts read after a toggle answer what was saved
const concepts = new Map([
  ['k1', label('k1', 'diff', 1, true)],
  ['k2', label('k2', 'claim', 2, false)],
])
const VIEW = { slug: 'board', origin: 'workspace', name: 'Board', why: '', claims: ['*.jsonl'], accepts: [], declares: [], default: false, libs: [], built: '2026-09-24T10:00:00Z', ok: true, forms: [], first_file: 'a.jsonl' }
const LISTING = { path: '', files: [{ path: 'a.jsonl', kind: 'jsonl', size_bytes: 10 }], folders: [], n_files: 1 }

beforeAll(async () => {
  script = await bundle('labels-pane', [
      `import { createRoot } from 'react-dom/client'`,
      `import { FilesTab } from '${src('files/FilesTab.tsx')}'`,
      `const el = document.createElement('div')`,
      `el.style.cssText = 'position:absolute;left:0;top:0;width:1200px;height:700px;display:flex;flex-direction:column'`,
      `document.body.appendChild(el)`,
      `createRoot(el).render(<FilesTab ws="mini" active />)`,
  ])
  browser = await launch()
  page = await browser.newPage({ viewport: { width: 1200, height: 700 } })
  page.on('pageerror', (e: any) => pageErrors.push(String(e)))
  await page.route('http://thimble.test/**', (route: any) => {
    const req = route.request()
    const url = new URL(req.url())
    const json = (body: any) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
    const put = url.pathname.match(/^\/api\/ws\/mini\/concepts\/(\w+)$/)
    if (req.method() === 'PUT' && put) {
      const body = JSON.parse(req.postData())
      sent.push({ path: url.pathname, body })
      concepts.set(put[1], { ...concepts.get(put[1]), ...body })
      return json(concepts.get(put[1]))
    }
    if (req.method() !== 'GET' && url.pathname.startsWith('/api/')) return json({ ok: true })
    if (url.pathname === '/api/ws/mini/concepts') return json([...concepts.values()])
    if (url.pathname === '/api/ws/mini/labels/presence') return json([])
    if (url.pathname === '/api/ws/mini/views') return json([VIEW])
    if (url.pathname === '/api/ws/mini/views/proposals') return json([])
    if (url.pathname === '/api/ws/mini/views/board/frame') return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><html><body><p>board</p></body></html>' })
    if (url.pathname === '/api/corpora/mini/sources') return json(LISTING)
    if (url.pathname.startsWith('/api/')) return route.fulfill({ status: 404, contentType: 'application/json', body: '{"detail":"no"}' })
    return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0"></body></html>' })
  })
  await page.goto('http://thimble.test/?ws=mini')
  await addStyles(page, ['tokens', 'base', 'components', 'shell', 'files'])
  await page.addScriptTag({ path: script })
  await page.waitForSelector('.files-label')
})

afterAll(async () => {
  await browser?.close()
  cleanup()
})

/** The labels a Labels pane lists under `scope`, each with whether it is on. */
const listed = (scope: any) => page.locator(`${scope} .files-label-toggle`).evaluateAll((bs: any) => bs.map((b: any) => [b.textContent, b.getAttribute('aria-pressed')]))
const pick = async (name: any) => {
  await page.locator('.files-views .seg-opt', { hasText: name }).click()
  await page.waitForTimeout(250)
}

test('the File browser keeps the Labels pane at the bottom of its sidebar, under the tree', async () => {
  assert.equal(await page.locator('.files-side-labels').count(), 0)
  assert.equal(await page.locator('.files-side .files-side-tree').count(), 1)
  assert.deepEqual(await listed('.files-side'), [['diff', 'true'], ['claim', 'false']])
})

test('a picked view has the same Labels pane in a sidebar of its own, with no tree, left of the view', async () => {
  await pick('Board')
  await page.waitForSelector('.view-pane')
  assert.equal(await page.locator('.files-side-tree').count(), 0, 'the tree stays in the File browser')
  assert.deepEqual(await listed('.files-side-labels'), [['diff', 'true'], ['claim', 'false']])
  const [side, view] = await Promise.all([page.locator('.files-side-labels').boundingBox(), page.locator('.view-pane').boundingBox()])
  assert.ok(side.x + side.width <= view.x + 1, 'the sidebar is left of the view')
  assert.ok(side.height > 600, 'the pane fills the sidebar from its top rather than sitting at its bottom')
  const head = await page.locator('.files-side-labels .files-side-head').boundingBox()
  assert.ok(head.y - side.y < 16, 'the pane head is at the top of the sidebar')
})

test('a label turned on beside the view is saved once and shows on in the File browser too', async () => {
  sent.length = 0
  await page.locator('.files-side-labels .files-label-toggle', { hasText: 'claim' }).click()
  await page.waitForTimeout(250)
  assert.deepEqual(sent, [{ path: '/api/ws/mini/concepts/k2', body: { shown: true } }])
  assert.deepEqual(await listed('.files-side-labels'), [['diff', 'true'], ['claim', 'true']])
  assert.equal(await page.locator('.view-pane').count(), 1, 'the view stays open')
  await pick('File browser')
  assert.deepEqual(await listed('.files-side'), [['diff', 'true'], ['claim', 'true']], 'one state for both panes')
  await page.locator('.files-side .files-label-toggle', { hasText: 'claim' }).click()
  await page.waitForTimeout(250)
  await pick('Board')
  assert.deepEqual(await listed('.files-side-labels'), [['diff', 'true'], ['claim', 'false']], 'and back the other way')
})

test('the view\'s Labels sidebar hides and comes back without touching the File browser\'s', async () => {
  await page.getByRole('button', { name: 'Hide labels', exact: true }).click()
  await page.waitForTimeout(200)
  assert.equal(await page.locator('.files-side-labels').count(), 0)
  const show = page.locator('.view-pane-head').getByRole('button', { name: 'Show labels', exact: true })
  assert.equal(await show.count(), 1, 'the button that brings it back stands in the view head')
  const [btn, name] = await Promise.all([show.boundingBox(), page.locator('.view-pane-name').boundingBox()])
  assert.ok(btn.x + btn.width <= name.x, 'before the view name')
  await pick('File browser')
  assert.equal(await page.locator('.files-side .files-side-tree').count(), 1, 'the File browser keeps its sidebar')
  await pick('Board')
  assert.equal(await page.locator('.files-side-labels').count(), 0, 'the view keeps its sidebar hidden')
  await page.locator('.view-pane-head').getByRole('button', { name: 'Show labels', exact: true }).click()
  await page.waitForTimeout(200)
  assert.equal(await page.locator('.files-side-labels').count(), 1)
  assert.equal(await page.locator('.view-pane-head').getByRole('button', { name: 'Show labels', exact: true }).count(), 0)
})

test('a label\'s edit card opens beside the view\'s Labels pane, level with its top', async () => {
  await page.getByRole('button', { name: 'Edit diff', exact: true }).click()
  await page.waitForSelector('.label-card')
  const [card, side] = await Promise.all([page.locator('.label-card').boundingBox(), page.locator('.files-side-labels').boundingBox()])
  assert.ok(Math.abs(card.x - (side.x + side.width - 10)) < 2, `10px over the sidebar's edge (${card.x} vs ${side.x + side.width})`)
  assert.ok(card.y - side.y < 20, 'from the top of the pane')
  await page.locator('.label-card').getByRole('button', { name: 'Cancel', exact: true }).click()
  await page.waitForTimeout(150)
  assert.equal(await page.locator('.label-card').count(), 0)
  assert.deepEqual(pageErrors, [])
})

test('in the narrowest pane that holds the Labels sidebar beside the view, the view\'s name and path keep room of their own, clear of the mode switch', async () => {
  const root = page.locator('.files-tab').locator('xpath=..')
  // the sidebar's width and the view's readable minimum (FilesTab, shell/dock.tsx): any narrower and the sidebar lies
  // over the view instead (narrow-layout.test.ts)
  const docked = await page.evaluate(() => Math.ceil((document.querySelector('.files-side-labels') as any).getBoundingClientRect().width + (document.querySelector('.read-probe > span') as any).getBoundingClientRect().width))
  await root.evaluate((el: any, w: any) => (el.style.width = `${w}px`), docked)
  // a name longer than the head has room for, in one word, so it cannot wrap its way clear
  await page.locator('.view-pane-name').evaluate((el: any) => (el.textContent = 'Agenttranscriptviewerwithlabels'))
  await page.waitForTimeout(100)
  const m = await page.evaluate(() => {
    const seg = (document.querySelector('.view-pane-head .seg') as any).getBoundingClientRect()
    const meets = (r: any) => r.right > seg.left && r.left < seg.right && r.bottom > seg.top && r.top < seg.bottom
    const parts = ['.view-pane-name', '.view-pane-file'].map((sel: any) => {
      const el = document.querySelector(sel)
      const clipped = getComputedStyle(el).overflowX === 'hidden'
      return { sel, clear: !meets(el.getBoundingClientRect()), inside: el.scrollWidth <= el.clientWidth + 1 || clipped }
    })
    const title = (document.querySelector('.view-pane-title') as any).getBoundingClientRect().width
    const head = (document.querySelector('.view-pane-head') as any).getBoundingClientRect().width
    return { parts, title, head }
  })
  assert.equal(await page.locator('.files-side-labels:not(.is-over)').count(), 1, 'the sidebar docks beside the view')
  for (const p of m.parts) {
    assert.ok(p.clear, `${p.sel} stays clear of the mode switch`)
    assert.ok(p.inside, `${p.sel} draws nothing past its box`)
  }
  assert.ok(m.title >= Math.min(180, m.head) - 1, `the name and path keep at least 180px (${m.title.toFixed(0)} of ${m.head.toFixed(0)})`)
  await root.evaluate((el: any) => (el.style.width = '1200px'))
})

test('a single-class label shows its square, filled while on and with no number; a click on a name focuses an on label, and on the focused one turns it off', async () => {
  await pick('File browser')
  const side = '.files-side'
  const state = () =>
    page.locator(`${side} .files-label`).evaluateAll((els: any) =>
      els.map((el: any) => {
        const mark = el.querySelector('.files-label-mark')
        const box = mark.querySelector('.files-label-box')
        return [el.querySelector('.files-label-name').textContent, box ? (box.classList.contains('on') ? 'filled' : 'empty') : 'none', mark.textContent, el.classList.contains('is-focus')]
      }),
    )
  const name = (n: string) => page.locator(`${side} .files-label-toggle`, { hasText: n })
  const mark = (n: string) => page.locator(`${side} .files-label`, { hasText: n }).locator('.files-label-mark')
  assert.deepEqual(await state(), [['diff', 'filled', '', false], ['claim', 'empty', '', false]], 'one label on: its square filled, no focus marked')
  sent.length = 0
  await name('claim').click()
  await page.waitForTimeout(250)
  assert.deepEqual(await state(), [['diff', 'filled', '', false], ['claim', 'filled', '', true]], 'turned on by its name: filled, and focused')
  await name('diff').click()
  await page.waitForTimeout(250)
  assert.deepEqual(await state(), [['diff', 'filled', '', true], ['claim', 'filled', '', false]], 'a click on an on label focuses it without turning it off')
  assert.deepEqual(sent, [{ path: '/api/ws/mini/concepts/k2', body: { shown: true } }], 'focusing saves nothing')
  await name('diff').click()
  await page.waitForTimeout(250)
  assert.deepEqual(await state(), [['diff', 'empty', '', false], ['claim', 'filled', '', false]], 'the focused label turned off')
  await mark('diff').click()
  await page.waitForTimeout(250)
  assert.deepEqual(await state(), [['diff', 'filled', '', true], ['claim', 'filled', '', false]], 'on again by its square, and focused')
  const kept = await page.evaluate(() => ['labelsOnOrder', 'labelFocus'].map((k) => JSON.parse(localStorage.getItem(`thimble:mini:${k}`) ?? 'null')))
  assert.deepEqual(kept, [['k2', 'k1'], 'k1'], 'the order they were turned on and the focus are kept in the browser')
  await mark('claim').click()
  await page.waitForTimeout(250)
  assert.deepEqual(await state(), [['diff', 'filled', '', false], ['claim', 'empty', '', false]], 'a click on the square turns an on label off whether or not it is focused')
  assert.deepEqual(pageErrors, [])
})
