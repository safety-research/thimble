// The main area's panes (src/shell/PaneArea.tsx over shell/panes.ts) in a real browser, with the app's stylesheets: two
// panes side by side are cards 12px apart, each with its head; a surface dragged onto a pane's edge shows where it would
// go and splits the pane when released, and a press that does not move is a click; the 12px between two panes drags
// the split and stops at a pane's least width; × in a head closes that pane and its sibling takes the room.
import assert from 'node:assert/strict'
import { afterAll, beforeAll, test } from 'vitest'
import type { Browser, Page } from 'playwright'
import { bundle, cleanup, launch, open, src, type Opened } from './page.ts'

let browser: Browser
let opened: Opened
let page: Page

const AREA = { x: 100, y: 100, w: 1100, h: 600 }

beforeAll(async () => {
  const script = await bundle('panes', [
    `import { createRoot } from 'react-dom/client'`,
    `import { useState } from 'react'`,
    `import { DragGhost, PaneArea, usePaneDrag } from '${src('shell/PaneArea.tsx')}'`,
    `import { arrange, close, drop, leaves, place, preset, resize, single } from '${src('shell/panes.ts')}'`,
    `const ALL = ['files', 'canvas', 'report']`,
    `function App() {`,
    `  const [panes, setPanes] = useState(() => preset(single('files'), 'columns', ALL, ['files', 'canvas']))`,
    `  const [area, setArea] = useState(null)`,
    `  const geometry = arrange(panes.root, { x: 0, y: 0, w: ${AREA.w}, h: ${AREA.h} })`,
    `  const { drag, start } = usePaneDrag({ area, geometry, panes, enabled: true, labelOf: (s) => s, onDrop: (pane, zone, s) => setPanes((p) => drop(p, pane, zone, s) ?? p) })`,
    `  window.__surfaces = leaves(panes.root).map((l) => l.surface)`,
    `  window.__dragging = !!drag`,
    `  const surfaces = ALL.map((id) => ({ id, label: id, icon: 'files', panel: id, keep: true, render: () => <div className="stub">{id}</div> }))`,
    `  return (<>`,
    `    <div id="tabs" style={{ position: 'absolute', left: 100, top: 20 }}>{ALL.map((id) => <button key={id} data-tab={id} onPointerDown={(e) => start(e, id)}>{id}</button>)}</div>`,
    `    <div className="shell-center" style={{ position: 'absolute', left: ${AREA.x}, top: ${AREA.y}, width: ${AREA.w}, height: ${AREA.h} }}>`,
    `      <PaneArea panes={panes} geometry={geometry} multi={geometry.panes.length > 1} surfaces={surfaces} area={setArea} drag={drag} onDragStart={start}`,
    `        onFocus={(id) => setPanes((p) => ({ ...p, focus: id }))} onPlace={(id, s) => setPanes((p) => place(p, id, s))}`,
    `        onClose={(id) => setPanes((p) => close(p, id))} onResize={(path, r) => setPanes((p) => resize(p, path, r))} />`,
    `    </div>`,
    `    {drag && <DragGhost drag={drag} />}`,
    `  </>)`,
    `}`,
    `const el = document.createElement('div')`,
    `document.body.appendChild(el)`,
    `createRoot(el).render(<App />)`,
  ])
  browser = await launch()
  opened = await open(browser, { script, styles: ['tokens', 'base', 'components', 'shell'], context: { viewport: { width: 1300, height: 800 } } })
  page = opened.page
  await page.waitForSelector('.shell-panel[data-surface="canvas"]:not([hidden])')
})

afterAll(async () => {
  await opened?.close()
  await browser?.close()
  cleanup()
})

const box = async (sel: string) => (await page.locator(sel).first().boundingBox())!
const surfacesNow = () => page.evaluate(() => (window as unknown as { __surfaces: string[] }).__surfaces)

test('two panes side by side are cards 12px apart, each with its head', async () => {
  const [a, b] = [await box('.shell-panel[data-surface="files"]'), await box('.shell-panel[data-surface="canvas"]')]
  assert.equal(a.x, AREA.x)
  assert.equal(b.x - (a.x + a.width), 12)
  assert.equal(b.x + b.width, AREA.x + AREA.w)
  assert.equal(await page.locator('.shell-panel[data-surface="report"]').isHidden(), true)
  const radius = await page.locator('.shell-panel[data-surface="files"]').evaluate((e) => getComputedStyle(e).borderTopLeftRadius)
  assert.equal(radius, '12px')
  assert.deepEqual(await page.locator('.pane-head .pane-name-text').allTextContents(), ['files', 'canvas'])
})

test('a press on a tab that does not move is a click: nothing drags', async () => {
  const t = await box('[data-tab="report"]')
  await page.mouse.move(t.x + 5, t.y + 5)
  await page.mouse.down()
  await page.mouse.move(t.x + 7, t.y + 6)
  assert.equal(await page.evaluate(() => (window as unknown as { __dragging: boolean }).__dragging), false)
  await page.mouse.up()
  assert.deepEqual(await surfacesNow(), ['files', 'canvas'])
})

test("a surface dragged to a pane's right edge shows the half it would take, and the release splits the pane", async () => {
  const t = await box('[data-tab="report"]')
  const files = await box('.shell-panel[data-surface="files"]')
  await page.mouse.move(t.x + 5, t.y + 5)
  await page.mouse.down()
  await page.mouse.move(t.x + 30, t.y + 30, { steps: 4 })
  await page.mouse.move(files.x + files.width - 20, files.y + files.height / 2, { steps: 8 })
  // the preview slides to its place (--dur-fast)
  await page.waitForTimeout(250)
  const drop = await box('.pane-drop')
  assert.equal(Math.round(drop.x + drop.width), Math.round(files.x + files.width), 'the preview hugs the right edge')
  assert.ok(Math.abs(drop.width - (files.width - 12) / 2) <= 1, 'and takes half the pane less the gap')
  assert.equal(await page.locator('.pane-ghost').textContent(), 'report')
  await page.mouse.up()
  await page.waitForTimeout(100)
  assert.deepEqual(await surfacesNow(), ['files', 'report', 'canvas'])
  assert.equal(await page.locator('.pane-drop').count(), 0)
  assert.equal(await page.locator('.pane-ghost').count(), 0)
})

test("the gap between two panes drags the split and stops at a pane's least width", async () => {
  // the split the drop made, between files and report
  const d = await box('.pane-divider[data-path="a"]')
  await page.mouse.move(d.x + d.width / 2, d.y + d.height / 2)
  await page.mouse.down()
  await page.mouse.move(AREA.x + 5, d.y + d.height / 2, { steps: 6 })
  await page.mouse.up()
  const files = await box('.shell-panel[data-surface="files"]')
  assert.ok(Math.abs(files.width - 240) <= 1, `files is kept at 240px, not ${files.width}`)
})

test('× in a head closes that pane and its sibling takes its room', async () => {
  await page.locator('.shell-panel[data-surface="report"] .pane-close').click()
  await page.waitForTimeout(100)
  assert.deepEqual(await surfacesNow(), ['files', 'canvas'])
  const canvas = await box('.shell-panel[data-surface="canvas"]')
  assert.equal(canvas.x + canvas.width, AREA.x + AREA.w)
  assert.deepEqual(opened.errors, [])
})
