// Choosing a label in a view's Color by (backend/app/viewer_colour.js) opens thimble's label editor (src/files/
// LabelEditor.tsx) beside the menu, with thimble's own stylesheets, in a real browser: the real ViewerFrame holds a view
// that mounts the kit's Color by, and the analyst's click on a label's row colors by the label and asks for its editor
// with the menu as the anchor. The editor stands beside the open menu in the page's coordinates, inside the window,
// with the label's prompt and classes, while the menu stays open with the label checked. Escape closes the editor and
// puts the focus back in the view on the label's row; a second Escape closes the menu. Choosing a field opens nothing.
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

const LABEL = {
  id: 'k1',
  name: 'activity type',
  description: 'What the agent is doing in this message: reading files, writing code, or something else.',
  unit: 'record',
  kind: 'prompt',
  spec: '',
  glob: 'm.jsonl',
  marks: 'record',
  labels: ['reading', 'writing', 'other'],
  created_by: 'analyst',
  ts: '',
  shown: true,
  classes: [
    { name: 'reading', color: 1, highlight: true },
    { name: 'writing', color: 2, highlight: true },
    { name: 'other', color: 0, highlight: false },
  ],
}

const ROWS = Array.from({ length: 30 }, (_, i) => `<div class="msg" data-anchor="m.jsonl#L${i + 1}" data-colour="${i % 3 ? 'Text only' : 'With links'}">message ${i + 1}</div>`).join('')
const VIEW = `<!doctype html><html><head><script>window.__thimbleView = {"slug":"board","name":"Board"}</script>
<script>${inline(read('viewer_bridge.js'))}</script><script>window.__thimbleLabelOrder = ${read('label_order.json')}</script><script>${inline(read('viewer_colour.js'))}</script><style>${read('viewer_kit.css')}</style>
<style>body{margin:0;font:12px sans-serif} .top{display:flex;align-items:center;gap:8px;padding:8px} #list{height:320px;overflow:auto} .msg{height:28px;padding:6px 12px 0}</style></head><body>
<div class="top"><span id="colour"></span></div><div id="list">${ROWS}</div>
<script>window.colour = thimble.colorBy({ mount: '#colour', fields: [{ name: 'kind', title: 'Kind', values: ['Text only', 'With links'] }], strip: '#list' })</script>
</body></html>`

beforeAll(async () => {
  const script = await bundle(
    'colorby-editor',
    [
      `import '${src('styles/index.css')}'`,
      `import { createElement as h } from 'react'`,
      `import { createRoot } from 'react-dom/client'`,
      `import { ViewerFrame } from '${src('files/ViewerFrame.tsx')}'`,
      `import { LabelEditorHost, openLabelEditor } from '${src('files/LabelEditor.tsx')}'`,
      `const w = window`,
      `w.__acts = []`,
      `const k = ${JSON.stringify(LABEL)}`,
      // the view's label controls as ViewPane gives them
      `const actions = { setOn: (id, on) => w.__acts.push(['on', id, on]), setColour: () => {}, edit: (id, at) => { w.__acts.push(['edit', id]); if (at) openLabelEditor({ id, ...at, appliesTo: ['m.jsonl'] }) } }`,
      `const root = document.body.appendChild(document.createElement('div'))`,
      `root.style.cssText = 'position:absolute;left:40px;top:56px;width:640px;height:420px;display:flex'`,
      `createRoot(root).render([h(ViewerFrame, { key: 'f', ws: 'w', slug: 'board', title: 'Board', byId: new Map([[k.id, k]]), labels: [k], labelActions: actions, className: 'test-frame' }), h(LabelEditorHost, { key: 'e', ws: 'w' })])`,
    ],
    { loader: { '.css': 'css', '.woff2': 'empty', '.woff': 'empty' }, conditions: ['style'] },
  )
  const css = readFileSync(script.replace(/\.js$/, '.css'), 'utf8')
  browser = await launch()
  page = await browser.newPage({ viewport: { width: 1100, height: 700 } })
  await page.route('**/*', async (route) => {
    const req = route.request()
    const p = new URL(req.url()).pathname
    if (p === '/bundle.css') return route.fulfill({ status: 200, contentType: 'text/css', body: css })
    if (p === '/api/ws/w/views/board/frame') return route.fulfill({ status: 200, contentType: 'text/html', body: VIEW })
    if (p.startsWith('/api/')) {
      const body = p === '/api/ws/w/concepts' ? [LABEL] : p === '/api/ws/w/labels/presence' ? [] : p === '/api/ws/w/labels/glob' ? { files: ['m.jsonl'], total: 1 } : p.endsWith('/labels') ? { row: {}, calibration: null } : p.endsWith('/records') ? { data: null } : {}
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
    }
    return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/bundle.css"><style>.test-frame{flex:1;border:0}</style></head><body></body></html>' })
  })
  await page.goto(`${ORIGIN}/`)
  await page.addScriptTag({ path: script })
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
const popOpen = () => page.evaluate(() => !!document.querySelector('.popover.label-editor-pop'))
const menuOpen = () => frame().evaluate(() => !!document.querySelector('.thimble-colour-menu'))
/** Where the focus is: the frame in the page, and in the frame's document. */
const focus = async () => ({ page: await page.evaluate(() => document.activeElement?.tagName ?? null), frame: await frame().evaluate(() => document.activeElement?.getAttribute('data-by') ?? document.activeElement?.className ?? null) })

test("choosing a label in Color by colors by it and opens the label's editor beside the open menu, inside the window", async () => {
  await frame().locator('.thimble-colour-by').click()
  await frame().locator('.thimble-colour-menu [data-by="l:k1"] .thimble-colour-nm').click()
  await page.waitForSelector('.popover.label-editor-pop', { state: 'visible' })
  // the popover's entrance animation ends before its box is read
  await page.waitForTimeout(300)
  const menu = await frame().evaluate(() => {
    const r = document.querySelector('.thimble-colour-menu')!.getBoundingClientRect()
    return { left: r.left, top: r.top, width: r.width, height: r.height }
  })
  const m = await page.evaluate((menu) => {
    const f = document.querySelector('iframe.test-frame')!.getBoundingClientRect()
    const pop = document.querySelector<HTMLElement>('.popover.label-editor-pop')!
    const p = pop.getBoundingClientRect()
    return {
      pop: { left: p.left, top: p.top, right: p.right, bottom: p.bottom, width: p.width },
      menu: { left: f.left + menu.left, top: f.top + menu.top, right: f.left + menu.left + menu.width, bottom: f.top + menu.top + menu.height },
      vw: innerWidth,
      vh: innerHeight,
      label: pop.getAttribute('aria-label'),
      prompt: pop.querySelector<HTMLTextAreaElement>('textarea[aria-label="Prompt"]')?.value ?? null,
      classes: [...pop.querySelectorAll<HTMLInputElement>('[aria-label="Class name"]')].map((e) => e.value),
    }
  }, menu)
  assert.ok(m.pop.left >= 0 && m.pop.top >= 0 && m.pop.right <= m.vw && m.pop.bottom <= m.vh, `inside the window ${JSON.stringify(m)}`)
  assert.ok(Math.abs(m.pop.left - (m.menu.right + 4)) <= 1 || Math.abs(m.pop.right - (m.menu.left - 4)) <= 1, `beside the menu, 4 px from its edge ${JSON.stringify(m)}`)
  assert.ok(m.pop.top < m.menu.bottom && m.pop.bottom > m.menu.top, `level with the menu ${JSON.stringify(m)}`)
  assert.equal(m.label, 'Edit activity type')
  assert.equal(m.prompt, LABEL.description)
  assert.deepEqual(m.classes, ['reading', 'writing', 'other'])
  // the view colors by the label, and its menu stays open with the label checked
  assert.equal(await frame().evaluate(() => document.querySelector('.thimble-colour-by b')!.textContent), 'activity type')
  assert.equal(await frame().evaluate(() => document.querySelector('.thimble-colour-menu [data-by="l:k1"]')!.getAttribute('aria-checked')), 'true')
  assert.deepEqual(await page.evaluate(() => (window as any).__acts), [['edit', 'k1']])
})

test("Escape closes the editor with the focus back in the view on the label's row; a second Escape closes the menu", async () => {
  await page.keyboard.press('Escape')
  await page.waitForFunction(() => !document.querySelector('.popover.label-editor-pop'))
  await frame().waitForFunction(() => document.activeElement?.getAttribute('data-by') === 'l:k1')
  assert.deepEqual(await focus(), { page: 'IFRAME', frame: 'l:k1' })
  assert.equal(await menuOpen(), true, 'the menu is still open')
  await page.keyboard.press('Escape')
  await frame().waitForFunction(() => !document.querySelector('.thimble-colour-menu'))
  assert.match(String((await focus()).frame), /thimble-colour-by/)
})

test('choosing a field opens no editor', async () => {
  await frame().locator('.thimble-colour-by').click()
  await frame().locator('.thimble-colour-menu [data-by="f:kind"]').click()
  await page.waitForTimeout(400)
  assert.equal(await popOpen(), false)
  assert.equal(await menuOpen(), false)
  assert.equal(await frame().evaluate(() => document.querySelector('.thimble-colour-by b')!.textContent), 'Kind')
  assert.deepEqual(await page.evaluate(() => (window as any).__acts), [['edit', 'k1']])
})
