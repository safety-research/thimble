// The view kit's tree (backend/app/viewer_tree.js, thimble.tree) in a real browser, a page holding the view in a
// sandboxed frame as ViewerFrame does: the keys move, fold, open and pick, and a click on a chevron folds without
// picking.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, test } from 'vitest'
import type { Browser, Frame, Page } from 'playwright'
import { cleanup, FRONTEND, launch } from './page.ts'

const APP = path.join(FRONTEND, '..', 'backend', 'app')
const read = (name: string) => readFileSync(path.join(APP, name), 'utf8')
const inline = (js: string) => js.replace(/<\/script/g, '<\\/script')
// the kit as views.frame_document loads it
const KIT =
  `<script>${inline(read('viewer_bridge.js'))}</script><script>window.__thimbleLabelOrder = ${read('label_order.json')}</script>` +
  ['viewer_colour.js', 'viewer_controls.js', 'viewer_side.js', 'viewer_transcript.js', 'viewer_search.js', 'viewer_table.js', 'viewer_tree.js', 'viewer_range.js']
    .map((n) => `<script>${inline(read(n))}</script>`)
    .join('') +
  `<style>${read('viewer_kit.css')}</style><style>${read('viewer_parts.css')}</style>`
const TOKENS =
  ':root{--label-1:#025ac3;--label-2:#d0750a;--label-3:#08632f;--label-none:#a09c93;--ink-rgb:27,26,24;--surface-card:#fffdf8;' +
  '--text-primary:#000;--text-secondary:#4a4844;--text-tertiary:#726f69;--text-placeholder:#a09c93;--accent:#5135ff;--radius-chip:4px;--radius-ui:6px;' +
  '--h-row:28px;--control-sm:28px;--h-control:24px;--h-chip:20px;--text-xs:12px;--text-ui-sm:12px;--text-sm:13px;--text-mono-sm:11px;--border-subtle:rgba(27,26,24,0.12);' +
  '--border-hairline:rgba(27,26,24,0.08);--border-strong:rgba(27,26,24,0.3);--surface-selected:rgba(27,26,24,0.06);--hl-bg:rgba(255,214,0,0.35);--font-body:sans-serif;--font-mono:monospace}'

/** A view whose body is `script`, with a mount #tree `width` px wide and 480 px tall; what it asks thimble to keep is
 * the outer page's window.__kept, and `kept` is what thimble kept of it before. */
const view = (script: string, width: number, kept?: unknown) => `<!doctype html><html><head><style>${TOKENS} html,body{margin:0;height:100%}
body{font:13px sans-serif;background:#fffdf8} .top{display:flex;gap:8px;padding:8px;height:28px} #tree{width:${width}px;height:480px}</style>
${kept ? `<script>window.__thimbleColour = ${JSON.stringify(kept)}</script>` : ''}${KIT}</head><body>
<div class="top"><span id="colour"></span></div><div id="tree"></div>
<script>window.picks = []
${script}</script></body></html>`

let browser: Browser
beforeAll(async () => {
  browser = await launch()
})
afterAll(async () => {
  await browser?.close()
  cleanup()
})

async function framed(script: string, width = 300, kept?: unknown): Promise<{ page: Page; frame: () => Frame; errors: string[] }> {
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } })
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  await page.setContent(`<!doctype html><html><body style="margin:0"><iframe id="f" sandbox="allow-scripts" style="border:0;width:900px;height:640px"></iframe></body></html>`)
  await page.evaluate(() => {
    const w = window as unknown as { __kept: unknown[] }
    w.__kept = []
    window.addEventListener('message', (e) => e.data && e.data.type === 'thimble:colour' && w.__kept.push(e.data.state))
  })
  await page.evaluate((doc) => ((document.getElementById('f') as HTMLIFrameElement).srcdoc = doc), view(script, width, kept))
  const frame = () => page.frames().find((f) => f !== page.mainFrame())!
  await page.waitForTimeout(300)
  await frame().waitForSelector('.thimble-tree-row', { state: 'attached' })
  return { page, frame, errors }
}
/** the rows drawn, in the order they stand: their names and keys */
const drawn = (frame: () => Frame) =>
  frame().evaluate(() =>
    [...document.querySelectorAll('.thimble-tree-row')]
      .map((r) => ({ top: (r as HTMLElement).offsetTop, name: r.querySelector('.thimble-tree-name')!.textContent, key: r.getAttribute('data-key'), active: r.classList.contains('active'), cursor: r.classList.contains('is-cursor') }))
      .sort((a, b) => a.top - b.top),
  )

// a repository's files as paths: 50 folders of 10 folders of 10 files
const REPO = `const files = []
for (let a = 0; a < 50; a++) for (let b = 0; b < 10; b++) for (let c = 0; c < 10; c++) files.push({ key: 'pkg' + a + '/mod' + b + '/file' + c + '.py', n: c + 1 })`

describe('the tree in a frame', () => {

  test('↑ ↓ move, → opens, ← folds and goes to the parent, Enter picks; a click on a chevron folds without picking', async () => {
    const { page, frame } = await framed(`${REPO}
window.tree = thimble.tree({ mount: '#tree', split: '/', items: files, anchor: (n) => 'view:repo/' + n.key, onPick: (n) => picks.push(n.key) })`)
    // 50 folders do not fit 20 rows open: the tree opens with them folded
    let rows = await drawn(frame)
    assert.deepEqual(rows.slice(0, 3).map((r) => r.name), ['pkg0', 'pkg1', 'pkg2'])
    assert.equal(await frame().evaluate(() => document.querySelector('.thimble-tree-row')!.getAttribute('data-anchor')), 'view:repo/pkg0')
    await frame().locator('#tree .thimble-tree-body').focus()
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('ArrowRight')
    await page.waitForTimeout(50)
    rows = await drawn(frame)
    assert.deepEqual(rows.slice(0, 4).map((r) => r.name), ['pkg0', 'pkg1', 'mod0', 'mod1'], 'pkg1 opens')
    assert.equal(rows.find((r) => r.cursor)!.name, 'pkg1')
    // the ring on the row the keys are on, which the tree names as its active row
    const ring = () =>
      frame().evaluate(() => {
        const r = document.querySelector('.thimble-tree-row.is-cursor')
        return { outline: r ? getComputedStyle(r).outlineStyle : null, active: document.querySelector('.thimble-tree-body')!.getAttribute('aria-activedescendant') === (r && r.id) }
      })
    assert.deepEqual(await ring(), { outline: 'solid', active: true })
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('ArrowRight')
    await page.waitForTimeout(50)
    rows = await drawn(frame)
    assert.deepEqual(rows.slice(2, 5).map((r) => r.name), ['mod0', 'file0.py', 'file1.py'], '→ goes into pkg1, opens mod0 and goes to its first file')
    assert.equal(rows.find((r) => r.cursor)!.name, 'file0.py')
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Enter')
    await page.waitForTimeout(50)
    assert.deepEqual(await frame().evaluate(() => (window as any).picks), ['pkg1/mod0/file1.py'])
    assert.equal((await drawn(frame)).find((r) => r.active)!.name, 'file1.py')
    assert.equal(await frame().evaluate(() => (window as any).tree.chosen), 'pkg1/mod0/file1.py')
    // ← goes to the parent, then folds it
    await page.keyboard.press('ArrowLeft')
    await page.keyboard.press('ArrowLeft')
    await page.waitForTimeout(50)
    rows = await drawn(frame)
    assert.equal(rows.find((r) => r.cursor)!.name, 'mod0')
    assert.deepEqual(rows.slice(2, 4).map((r) => r.name), ['mod0', 'mod1'])
    // a chevron's click folds pkg1 and picks nothing
    await frame().locator('.thimble-tree-row[data-key="pkg1"] .thimble-tree-fold').click()
    await page.waitForTimeout(50)
    assert.deepEqual((await drawn(frame)).slice(0, 3).map((r) => r.name), ['pkg0', 'pkg1', 'pkg2'])
    assert.equal((await frame().evaluate(() => (window as any).picks)).length, 1)
    // a click on a row picks it and opens it, with no ring; on the chosen folder again, folds it
    await frame().locator('.thimble-tree-row[data-key="pkg2"]').click()
    await page.waitForTimeout(50)
    assert.deepEqual((await drawn(frame)).slice(2, 4).map((r) => r.name), ['pkg2', 'mod0'])
    assert.equal((await ring()).outline, 'none')
    await frame().locator('.thimble-tree-row[data-key="pkg2"]').click()
    await page.waitForTimeout(50)
    assert.deepEqual((await drawn(frame)).slice(2, 4).map((r) => r.name), ['pkg2', 'pkg3'])
    assert.deepEqual(await frame().evaluate(() => (window as any).picks), ['pkg1/mod0/file1.py', 'pkg2', 'pkg2'])
    await page.close()
  })
})
