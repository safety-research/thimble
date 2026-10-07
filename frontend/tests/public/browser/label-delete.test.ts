// A label's delete in a real browser, with thimble's own stylesheets: the real Labels pane and its editor at the pane's
// edge (src/files/ViewSide.tsx), the labels read and deleted through useFilesLabels, beside the real ViewerFrame holding
// a view that mounts the kit's Color by (backend/app/viewer_colour.js). Delete label in a row's ⋯ menu opens a confirm
// by the ⋯, inside the window, that names the label and what goes with it, with the focus on Cancel; Delete sends
// DELETE /concepts/{id}, the row goes, the label leaves the view's Color by menu, and the view, which was colored by
// it, falls back to Off. Delete label at the end of the editor's More does the same and closes the editor.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, test } from 'vitest'
import type { Browser, Frame, Page } from 'playwright'
import { bundle, cleanup, FRONTEND, launch, ORIGIN, src } from './page.ts'

const APP = path.join(FRONTEND, '..', 'backend', 'app')
const read = (name: string) => readFileSync(path.join(APP, name), 'utf8')
const inline = (js: string) => js.replace(/<\/script/g, '<\\/script')
let browser: Browser
let page: Page
const deleted: string[] = []

const label = (id: string, name: string, values: string[]) => ({
  id,
  name,
  description: `Which of ${values.join(', ')} the message is.`,
  unit: 'record',
  kind: 'prompt',
  spec: '',
  glob: 'm.jsonl',
  marks: 'record',
  labels: values,
  created_by: 'analyst',
  ts: '',
  shown: true,
  classes: values.map((v, i) => ({ name: v, color: i + 1, highlight: true })),
})
let LABELS = [label('k1', 'activity type', ['reading', 'writing']), label('k2', 'asks', ['asks', 'other'])]

const ROWS = Array.from({ length: 20 }, (_, i) => `<div class="msg" data-anchor="m.jsonl#L${i + 1}" data-colour="${i % 3 ? 'Text only' : 'With links'}">message ${i + 1}</div>`).join('')
// the view kept on Off with the label seen already, so that checking the label makes it the one choice
const VIEW = `<!doctype html><html><head><script>window.__thimbleView = {"slug":"board","name":"Board"}; window.__thimbleColour = {"v":1,"by":"off","picks":[],"seen":["k1","k2"],"off":{}}</script>
<script>${inline(read('viewer_bridge.js'))}</script><script>window.__thimbleLabelOrder = ${read('label_order.json')}</script><script>${inline(read('viewer_colour.js'))}</script><style>${read('viewer_kit.css')}</style>
<style>body{margin:0;font:12px sans-serif} .top{display:flex;align-items:center;gap:8px;padding:8px} #list{height:320px;overflow:auto} .msg{height:28px;padding:6px 12px 0}</style></head><body>
<div class="top"><span id="colour"></span></div><div id="list">${ROWS}</div>
<script>window.colour = thimble.colorBy({ mount: '#colour', fields: [{ name: 'kind', title: 'Kind', values: ['Text only', 'With links'] }], strip: '#list' })</script>
</body></html>`

beforeAll(async () => {
  const script = await bundle(
    'label-delete',
    [
      `import '${src('styles/index.css')}'`,
      `import { useState } from 'react'`,
      `import { createRoot } from 'react-dom/client'`,
      `import { ViewerFrame } from '${src('files/ViewerFrame.tsx')}'`,
      `import { useFilesLabels } from '${src('files/useLabels.ts')}'`,
      `import { useLabelRuns, useLabelSide } from '${src('files/ViewSide.tsx')}'`,
      `function Harness() {`,
      `  const labels = useFilesLabels('w')`,
      `  const [editing, setEditing] = useState<string | null>(null)`,
      `  const runs = useLabelRuns('w', labels)`,
      `  const side = useLabelSide({ ws: 'w', labels, runs, open: true, onToggleOpen: () => {}, editing, onEdit: setEditing, drafted: null, onDraft: () => {}, appliesTo: ['m.jsonl'], width: 260, onWidth: () => {}, onWidthEnd: () => {}, maxWidth: 400 })`,
      `  const actions = { setOn: (id: string) => labels.toggle(id), setColour: () => {}, edit: () => {} }`,
      `  return (`,
      `    <div style={{ position: 'absolute', inset: 0, display: 'flex' }}>`,
      `      <div className="test-side" style={{ width: 260, position: 'relative', flex: 'none', overflow: 'visible' }}>{side.pane}{side.card}</div>`,
      `      <ViewerFrame ws="w" slug="board" title="Board" byId={labels.byId} labels={labels.on} labelActions={actions} className="test-frame" />`,
      `    </div>`,
      `  )`,
      `}`,
      `createRoot(document.body.appendChild(document.createElement('div'))).render(<Harness />)`,
    ],
    { loader: { '.css': 'css', '.woff2': 'empty', '.woff': 'empty' }, conditions: ['style'] },
  )
  const css = readFileSync(script.replace(/\.js$/, '.css'), 'utf8')
  browser = await launch()
  page = await browser.newPage({ viewport: { width: 1100, height: 700 } })
  await page.route('**/*', async (route) => {
    const req = route.request()
    const p = new URL(req.url()).pathname
    const json = (body: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
    if (p === '/bundle.css') return route.fulfill({ status: 200, contentType: 'text/css', body: css })
    if (p === '/api/ws/w/views/board/frame') return route.fulfill({ status: 200, contentType: 'text/html', body: VIEW })
    const del = /^\/api\/ws\/w\/concepts\/([^/]+)$/.exec(p)
    if (del && req.method() === 'DELETE') {
      deleted.push(del[1])
      LABELS = LABELS.filter((k) => k.id !== del[1])
      return json({ ok: true })
    }
    if (p === '/api/ws/w/concepts') return json(LABELS)
    if (p === '/api/ws/w/labels/presence') return json([])
    if (p === '/api/ws/w/labels/glob') return json({ files: ['m.jsonl'], total: 1 })
    if (p.startsWith('/api/')) return json(p.endsWith('/records') ? { data: null } : {})
    return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/bundle.css"><style>.test-frame{flex:1;border:0}</style></head><body></body></html>' })
  })
  await page.goto(`${ORIGIN}/`)
  await page.addScriptTag({ path: script })
  await page.waitForSelector('.files-label-row')
  await page.waitForFunction(() => document.querySelector('iframe.test-frame'))
  await frame().waitForSelector('.thimble-colour-by')
  // the frame says ready and gets its key before a label call can go through
  await page.waitForTimeout(400)
})

afterAll(async () => {
  await browser?.close()
  cleanup()
})

const frame = (): Frame => page.frames().find((f) => f !== page.mainFrame())!
const rows = () => page.evaluate(() => [...document.querySelectorAll('.files-label-name')].map((e) => e.textContent))
const colorBy = () => frame().evaluate(() => document.querySelector('.thimble-colour-by b')?.textContent ?? null)
/** The labels the view's Color by menu lists, by their `data-by`. */
async function menuLabels(): Promise<string[]> {
  await frame().locator('.thimble-colour-by').click()
  await frame().waitForSelector('.thimble-colour-menu')
  const by = await frame().evaluate(() => [...document.querySelectorAll('.thimble-colour-menu [data-by^="l:"]')].map((e) => e.getAttribute('data-by')!))
  await frame().locator('.thimble-colour-by').click()
  await frame().waitForFunction(() => !document.querySelector('.thimble-colour-menu'))
  return by
}

test("Delete label in a row's ⋯ asks first by the ⋯, then deletes the label, which leaves the view's Color by, and the view falls back to Off", async () => {
  // the view colors by the label first
  await frame().locator('.thimble-colour-by').click()
  await frame().locator('.thimble-colour-menu [data-by="l:k1"] .thimble-colour-nm').click()
  await frame().waitForFunction(() => document.querySelector('.thimble-colour-by b')?.textContent === 'activity type')
  if (await frame().evaluate(() => !!document.querySelector('.thimble-colour-menu'))) await frame().locator('.thimble-colour-by').click()
  assert.deepEqual(await menuLabels(), ['l:k1', 'l:k2'])

  await page.locator('button[aria-label="Edit or delete activity type"]').click()
  await page.locator('.menu-item', { hasText: 'Delete label' }).click()
  await page.waitForSelector('.popover.files-label-delete', { state: 'visible' })
  await page.waitForTimeout(300)
  const m = await page.evaluate(() => {
    const pop = document.querySelector<HTMLElement>('.popover.files-label-delete')!
    const p = pop.getBoundingClientRect()
    const at = document.querySelector('button[aria-label="Edit or delete activity type"]')!.getBoundingClientRect()
    return { pop: { left: p.left, top: p.top, right: p.right, bottom: p.bottom }, at: { bottom: at.bottom }, vw: innerWidth, vh: innerHeight, text: pop.textContent, focus: document.activeElement?.textContent }
  })
  assert.ok(m.pop.left >= 0 && m.pop.top >= 0 && m.pop.right <= m.vw && m.pop.bottom <= m.vh, `inside the window ${JSON.stringify(m)}`)
  assert.ok(m.pop.top >= m.at.bottom, `under the ⋯ ${JSON.stringify(m)}`)
  assert.match(String(m.text), /^Delete activity type\? Its marks, its card and any filter that uses it are deleted with it\.CancelDelete$/)
  assert.equal(m.focus, 'Cancel')

  await page.locator('.popover.files-label-delete button', { hasText: /^Delete$/ }).click()
  await page.waitForFunction(() => ![...document.querySelectorAll('.files-label-name')].some((e) => e.textContent === 'activity type'))
  assert.deepEqual(deleted, ['k1'])
  assert.deepEqual(await rows(), ['asks'])
  assert.equal(await page.evaluate(() => !!document.querySelector('.popover.files-label-delete')), false)
  await frame().waitForFunction(() => document.querySelector('.thimble-colour-by b')?.textContent === 'Off')
  assert.equal(await colorBy(), 'Off')
  assert.deepEqual(await menuLabels(), ['l:k2'])
})

test("Delete label at the end of the editor's More asks first, then deletes the label and closes the editor", async () => {
  await page.locator('button[aria-label="Edit or delete asks"]').click()
  await page.locator('.menu-item', { hasText: 'Edit label' }).click()
  await page.waitForSelector('.label-card')
  if ((await page.locator('.label-card-more').getAttribute('aria-expanded')) !== 'true') await page.locator('.label-card-more').click()
  await page.locator('.label-card-delete').click()
  await page.waitForSelector('.popover.files-label-delete', { state: 'visible' })
  assert.match(String(await page.locator('.popover.files-label-delete').textContent()), /^Delete asks\? Its marks, its card and any filter that uses it are deleted with it\./)
  await page.locator('.popover.files-label-delete button', { hasText: /^Delete$/ }).click()
  await page.waitForFunction(() => !document.querySelector('.files-label-row'))
  assert.deepEqual(deleted, ['k1', 'k2'])
  assert.equal(await page.evaluate(() => !!document.querySelector('.label-card')), false)
  assert.deepEqual(await menuLabels(), [])
})
