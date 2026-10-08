// The label editor in its popover over a view (src/files/LabelEditor.tsx), with thimble's own stylesheets, in a real
// browser: the real ViewerFrame holds a view in its sandboxed frame, and the analyst's click on a control in the view
// asks for a label's editor beside it (backend/app/viewer_bridge.js editLabel, its `anchor` a rect in the frame's
// coordinates). The popover stands beside that control in the page's coordinates, inside the window, over the frame's
// edge rather than clipped by it, at the card's width, scrolling inside itself when the window is short, with the
// label's prompt and classes, compact: no Re-run until something changed, and More folded. Escape closes it with the focus back in the view, on the control, and the view hears it;
// a click in the view closes it too; Re-run saves and applies the label as Files does. With no rect it stands inside
// the view's top-left corner.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, test } from 'vitest'
import type { Browser, Frame, Page } from 'playwright'
import { bundle, cleanup, FRONTEND, launch, ORIGIN, src } from './page.ts'

const BRIDGE = readFileSync(path.join(FRONTEND, '..', 'backend', 'app', 'viewer_bridge.js'), 'utf8')
let browser: Browser
let page: Page
let css = ''
const api: { method: string; path: string; body: string | null }[] = []

const LABEL = {
  id: 'k1',
  name: 'activity type',
  description: 'What the agent is doing in this message: reading files, writing code, or something else.',
  unit: 'record',
  kind: 'prompt',
  spec: '',
  glob: 'transcript.jsonl',
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

// a view whose controls ask for the editor: beside the control itself (an element), beside a rect the page measured,
// and with no anchor; each tells the test when its editor closed
const VIEW = `<!doctype html><html><head><script>window.__thimbleView = {"slug":"board","name":"Board"}</script>
<script>${BRIDGE.replace(/<\/script/g, '<\\/script')}</script>
<style>body{margin:0;font:12px sans-serif} button{position:absolute} #pick{right:12px;top:40px} #rect{left:20px;bottom:24px} #plain{left:20px;top:40px}</style></head><body>
<button id="pick">activity type</button><button id="rect">by rect</button><button id="plain">no anchor</button>
<script>
const closed = (what) => () => parent.postMessage({ type: 'test:closed', what }, '*')
const ok = (what) => (p) => p.then(() => parent.postMessage({ type: 'test:asked', what }, '*'), (e) => parent.postMessage({ type: 'test:asked', what, error: e.message }, '*'))
document.getElementById('pick').onclick = (e) => ok('pick')(thimble.editLabel('k1', { anchor: e.currentTarget, onClose: closed('pick') }))
document.getElementById('rect').onclick = (e) => {
  const r = e.currentTarget.getBoundingClientRect()
  ok('rect')(thimble.editLabel('k1', { anchor: { left: r.left, top: r.top, width: r.width, height: r.height }, onClose: closed('rect') }))
}
document.getElementById('plain').onclick = () => ok('plain')(thimble.editLabel('k1', { onClose: closed('plain') }))
</script></body></html>`

beforeAll(async () => {
  const script = await bundle(
    'label-editor-pop',
    [
      `import '${src('styles/index.css')}'`,
      `import { createElement as h } from 'react'`,
      `import { createRoot } from 'react-dom/client'`,
      `import { ViewerFrame } from '${src('files/ViewerFrame.tsx')}'`,
      `import { LabelEditorHost, openLabelEditor } from '${src('files/LabelEditor.tsx')}'`,
      `const w = window`,
      `w.__closed = []`,
      `w.__asked = []`,
      `addEventListener('message', (e) => { if (e.data && e.data.type === 'test:closed') w.__closed.push(e.data.what); if (e.data && e.data.type === 'test:asked') w.__asked.push(e.data) })`,
      `const k = ${JSON.stringify(LABEL)}`,
      // the view's label controls as ViewPane gives them
      `const actions = { setOn: () => {}, setColour: () => {}, edit: (id, at) => at && openLabelEditor({ id, ...at, appliesTo: ['transcript.jsonl'] }) }`,
      `const root = document.body.appendChild(document.createElement('div'))`,
      // the frame sits off the page's corner, under a head and beside a column, as a view's pane does
      `root.style.cssText = 'position:absolute;left:40px;top:56px;width:560px;height:440px;display:flex'`,
      `createRoot(root).render([h(ViewerFrame, { key: 'f', ws: 'w', slug: 'board', title: 'Board', byId: new Map([[k.id, k]]), labels: [k], labelActions: actions, className: 'test-frame' }), h(LabelEditorHost, { key: 'e', ws: 'w' })])`,
    ],
    { loader: { '.css': 'css', '.woff2': 'empty', '.woff': 'empty' }, conditions: ['style'] },
  )
  css = readFileSync(script.replace(/\.js$/, '.css'), 'utf8')
  browser = await launch()
  page = await browser.newPage({ viewport: { width: 1000, height: 700 } })
  await page.route('**/*', async (route) => {
    const req = route.request()
    const url = new URL(req.url())
    const p = url.pathname
    if (p === '/bundle.css') return route.fulfill({ status: 200, contentType: 'text/css', body: css })
    if (p === '/api/ws/w/views/board/frame') return route.fulfill({ status: 200, contentType: 'text/html', body: VIEW })
    if (p.startsWith('/api/')) {
      api.push({ method: req.method(), path: p, body: req.postData() })
      const body =
        p === '/api/ws/w/concepts' ? [LABEL]
        : p === '/api/ws/w/labels/presence' ? []
        : p === '/api/ws/w/labels/glob' ? { files: ['transcript.jsonl'], total: 1 }
        : p === '/api/ws/w/concepts/k1' && req.method() === 'PUT' ? { ...LABEL, ...JSON.parse(req.postData() ?? '{}') }
        : p === '/api/ws/w/concepts/k1/apply' ? { status: 'running', started: new Date().toISOString() }
        : p.endsWith('/labels') ? { row: {}, calibration: null }
        : {}
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
    }
    return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/bundle.css"><style>.test-frame{flex:1;border:0}</style></head><body></body></html>' })
  })
  await page.goto(`${ORIGIN}/`)
  await page.addScriptTag({ path: script })
  await page.waitForFunction(() => document.querySelector('iframe.test-frame'))
  await frame().waitForSelector('#pick')
  // the frame says ready and gets its key before a label call can go through
  await page.waitForTimeout(300)
})

afterAll(async () => {
  await browser?.close()
  cleanup()
})

const frame = (): Frame => page.frames().find((f) => f !== page.mainFrame())!

type Box = { left: number; top: number; right: number; bottom: number; width: number; height: number }

/** The popover's box, the frame's, the control's in the page's coordinates, the window, and what the popover shows. */
async function measure(control: string) {
  await page.waitForSelector('.popover.label-editor-pop', { state: 'visible' })
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.popover.label-editor-pop')!).visibility === 'visible')
  // the popover's entrance animation ends before its box is read
  await page.waitForTimeout(300)
  const inFrame = await frame().evaluate((id) => {
    const r = document.getElementById(id)!.getBoundingClientRect()
    return { left: r.left, top: r.top, width: r.width, height: r.height }
  }, control)
  return page.evaluate((c) => {
    const box = (r: DOMRect) => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height })
    const pop = document.querySelector<HTMLElement>('.popover.label-editor-pop')!
    const f = document.querySelector('iframe.test-frame')!.getBoundingClientRect()
    const p = pop.getBoundingClientRect()
    const anchor = { left: f.left + c.left, top: f.top + c.top, right: f.left + c.left + c.width, bottom: f.top + c.top + c.height, width: c.width, height: c.height }
    // the popover is drawn over the frame's edge: the topmost element at a point of it outside the frame is the popover's
    const outside = p.left < f.left ? { x: (p.left + Math.min(p.right, f.left)) / 2, y: (p.top + p.bottom) / 2 } : p.right > f.right ? { x: (Math.max(p.left, f.right) + p.right) / 2, y: (p.top + p.bottom) / 2 } : null
    const hit = outside ? document.elementFromPoint(outside.x, outside.y) : null
    return {
      pop: box(p),
      frame: box(f),
      anchor,
      vw: innerWidth,
      vh: innerHeight,
      overFrameEdge: outside ? !!hit && pop.contains(hit) : null,
      scrolls: pop.scrollHeight > pop.clientHeight + 1,
      label: pop.getAttribute('aria-label'),
      prompt: pop.querySelector<HTMLTextAreaElement>('textarea[aria-label="Prompt"]')?.value ?? null,
      classes: [...pop.querySelectorAll<HTMLInputElement>('[aria-label="Class name"]')].map((e) => e.value),
      foot: [...pop.querySelectorAll('.label-card-foot button')].map((b) => b.textContent?.trim()),
      close: !!pop.querySelector('.label-card-head [aria-label="Close"]'),
      more: pop.querySelector('.label-card-more')?.getAttribute('aria-expanded') ?? null,
      focusInside: pop.contains(document.activeElement),
    }
  }, inFrame)
}

const inside = (b: Box, vw: number, vh: number) => b.left >= 0 && b.top >= 0 && b.right <= vw && b.bottom <= vh
const closed = () => page.evaluate(() => (window as any).__closed as string[])
const asked = () => page.evaluate(() => (window as any).__asked as { what: string; error?: string }[])
const open = () => page.evaluate(() => !!document.querySelector('.popover.label-editor-pop'))
/** Where the focus is: the frame in the page, and the element in the frame's document. */
const focus = async () => ({ page: await page.evaluate(() => document.activeElement?.tagName ?? null), frame: await frame().evaluate(() => document.activeElement?.id ?? null) })

test("the analyst's click on a control in the view opens the editor beside it, inside the window and over the frame's edge", async () => {
  await frame().locator('#pick').click()
  const m = await measure('pick')
  assert.deepEqual(await asked(), [{ type: 'test:asked', what: 'pick' }], 'the call went through')
  assert.ok(inside(m.pop, m.vw, m.vh), `the popover is inside the window ${JSON.stringify(m)}`)
  assert.equal(Math.round(m.pop.width), 340, "the editor's own width")
  // beside the control: to its right where there is room, else to its left, 4 px from it, level with it
  const right = Math.abs(m.pop.left - (m.anchor.right + 4)) <= 1
  const left = Math.abs(m.pop.right - (m.anchor.left - 4)) <= 1
  assert.ok(right || left, `the popover's edge is 4 px from the control's ${JSON.stringify(m)}`)
  const mid = (m.anchor.top + m.anchor.bottom) / 2
  assert.ok(m.pop.top <= mid && mid <= m.pop.bottom, `level with the control ${JSON.stringify(m)}`)
  assert.equal(m.overFrameEdge, true, `drawn over the frame's edge, not clipped by it ${JSON.stringify(m)}`)
  assert.equal(m.label, 'Edit activity type')
  assert.equal(m.prompt, 'What the agent is doing in this message: reading files, writing code, or something else.')
  assert.deepEqual(m.classes, ['reading', 'writing', 'other'])
  // compact: only × until something changes, and More folded
  assert.deepEqual([m.foot, m.close, m.more], [[], true, 'false'])
  assert.equal(m.focusInside, true, 'the popover has the focus')
})

test('Escape closes it, with the focus back in the view on the control, and the view hears it', async () => {
  await page.keyboard.press('Escape')
  await page.waitForFunction(() => !document.querySelector('.popover.label-editor-pop'))
  assert.deepEqual(await focus(), { page: 'IFRAME', frame: 'pick' })
  await page.waitForFunction(() => (window as any).__closed.length === 1)
  assert.deepEqual(await closed(), ['pick'])
})

test("a rect the page measured places it the same way, and a click in the view closes it", async () => {
  await frame().locator('#rect').click()
  const m = await measure('rect')
  assert.ok(inside(m.pop, m.vw, m.vh), JSON.stringify(m))
  assert.ok(Math.abs(m.pop.left - (m.anchor.right + 4)) <= 1, `to the right of the control near the frame's left edge ${JSON.stringify(m)}`)
  const mid = (m.anchor.top + m.anchor.bottom) / 2
  assert.ok(m.pop.top <= mid && mid <= m.pop.bottom, `level with the control ${JSON.stringify(m)}`)
  // a click in the view, away from the popover and the controls
  await page.mouse.click(m.frame.left + 20, m.frame.top + 12)
  await page.waitForFunction(() => !document.querySelector('.popover.label-editor-pop'))
  await page.waitForFunction(() => (window as any).__closed.length === 2)
  assert.deepEqual(await closed(), ['pick', 'rect'])
})

test("with no anchor it stands inside the view's top-left corner", async () => {
  await frame().locator('#plain').click()
  const m = await measure('plain')
  assert.deepEqual([Math.round(m.pop.left - m.frame.left), Math.round(m.pop.top - m.frame.top)], [8, 8], JSON.stringify(m))
  await page.keyboard.press('Escape')
  await page.waitForFunction(() => !document.querySelector('.popover.label-editor-pop'))
})

test('in a short window, with More open, it fits and scrolls inside itself', async () => {
  await page.setViewportSize({ width: 1000, height: 360 })
  await frame().locator('#pick').click()
  await measure('pick')
  await page.locator('.popover.label-editor-pop .label-card-more').click()
  const m = await measure('pick')
  assert.ok(inside(m.pop, m.vw, m.vh), JSON.stringify(m))
  assert.ok(m.pop.height <= m.vh - 16 + 1, JSON.stringify(m))
  assert.equal(m.scrolls, true, 'the popover scrolls inside itself')
  // More folded again for the tests after, since the page keeps it as it was left
  await page.locator('.popover.label-editor-pop .label-card-more').click()
  await page.keyboard.press('Escape')
  await page.waitForFunction(() => !document.querySelector('.popover.label-editor-pop'))
  await page.setViewportSize({ width: 1000, height: 700 })
})

test('Re-run saves the edited prompt and applies the label, as in Files, then closes with the focus back in the view', async () => {
  await frame().locator('#pick').click()
  await measure('pick')
  const prompt = page.locator('.popover.label-editor-pop textarea[aria-label="Prompt"]')
  await prompt.fill('What the agent does in this message.')
  api.length = 0
  await page.locator('.popover.label-editor-pop .label-card-foot button', { hasText: 'Re-run' }).click()
  await page.waitForFunction(() => !document.querySelector('.popover.label-editor-pop'))
  const put = api.find((c) => c.method === 'PUT' && c.path === '/api/ws/w/concepts/k1')
  assert.ok(put, JSON.stringify(api))
  assert.equal(JSON.parse(put.body ?? '{}').description, 'What the agent does in this message.')
  assert.ok(api.some((c) => c.method === 'POST' && c.path === '/api/ws/w/concepts/k1/apply'), JSON.stringify(api))
  assert.equal(await open(), false)
  assert.deepEqual(await focus(), { page: 'IFRAME', frame: 'pick' })
})
