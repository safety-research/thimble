// The view kit's transcript (backend/app/viewer_transcript.js, viewer_parts.css) in a real browser, in a sandboxed frame
// as ViewerFrame holds a view: a tool call folds to one line, and the chevron at the start of its head opens it and folds
// it again, turned, in one place, so a click on the same spot does both; a long result shows Show more under its cut
// text and Show less in the same place once open; the keyboard reaches both, ringed, and keeps the focus as the turn is
// drawn again. What the transcript decides without layout is tests/public/controls-kit.test.ts.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, test } from 'vitest'
import type { Browser, Frame, Page } from 'playwright'
import { cleanup, FRONTEND, launch } from './page.ts'

const APP = path.join(FRONTEND, '..', 'backend', 'app')
const read = (name: string) => readFileSync(path.join(APP, name), 'utf8')
const inline = (js: string) => js.replace(/<\/script/g, '<\\/script')
// the kit as views.frame_document loads it
const KIT =
  `<script>${inline(read('viewer_bridge.js'))}</script><script>window.__thimbleLabelOrder = ${read('label_order.json')}</script>` +
  ['viewer_colour.js', 'viewer_controls.js', 'viewer_side.js', 'viewer_transcript.js', 'viewer_range.js'].map((n) => `<script>${inline(read(n))}</script>`).join('') +
  `<style>${read('viewer_kit.css')}</style><style>${read('viewer_parts.css')}</style>`
const TOKENS =
  ':root{--ink-rgb:27,26,24;--surface-card:#fffdf8;--bg-sunken:#f3f0e8;--text-primary:#000;--text-secondary:#4a4844;--text-tertiary:#726f69;' +
  '--text-placeholder:#a09c93;--accent:#5135ff;--radius-chip:4px;--radius-ui:6px;--radius-hl:3px;--h-control:24px;--text-xs:12px;--text-ui-sm:12px;' +
  '--text-sm:13px;--text-mono-sm:11px;--border-hairline:rgba(27,26,24,0.08);--border-strong:rgba(27,26,24,0.3);--status-negative:#c93a28;' +
  '--font-body:sans-serif;--font-mono:monospace}'
const T0 = Date.UTC(2026, 4, 16, 9) / 1000

const view = `<!doctype html><html><head><style>${TOKENS} html,body{margin:0} body{font:12px sans-serif;background:#fffdf8}</style>${KIT}</head>
<body><div id="turns"></div><script>
const long = Array.from({ length: 30 }, (_, i) => 'line ' + (i + 1)).join('\\n')
window.tr = thimble.transcript({ mount: '#turns' })
tr.draw([
  { ref: 's.jsonl#L1', t: ${T0}, speaker: 'user', kind: 'prompt', text: 'Find the failing test', line: 1 },
  { ref: 's.jsonl#L2', t: ${T0 + 5}, speaker: 'lead', kind: 'tool', tool: 'Bash', input: 'pytest -q', output: long, line: 2 },
  { ref: 's.jsonl#L3', t: ${T0 + 9}, speaker: 'lead', kind: 'text', text: 'One test fails.', line: 3 },
], { title: 'lead · Run 1' })
</script></body></html>`

let browser: Browser
let page: Page
let frame: () => Frame

beforeAll(async () => {
  browser = await launch()
  page = await browser.newPage({ viewport: { width: 900, height: 900 } })
  await page.setContent(`<!doctype html><html><body style="margin:0"><iframe id="f" sandbox="allow-scripts" style="border:0;width:800px;height:860px"></iframe></body></html>`)
  await page.evaluate((doc) => ((document.getElementById('f') as HTMLIFrameElement).srcdoc = doc), view)
  frame = () => page.frames().find((f) => f !== page.mainFrame())!
  await page.waitForTimeout(300)
  await frame().waitForSelector('.thimble-turn', { state: 'attached' })
})
afterAll(async () => {
  await browser?.close()
  cleanup()
})

const TURN = '[data-anchor="s.jsonl#L2"]'
/** an element's box in the page, the frame at its top left */
const box = (sel: string) => frame().evaluate((s) => document.querySelector(s)!.getBoundingClientRect().toJSON() as DOMRect, sel)
const has = (sel: string) => frame().evaluate((s) => document.querySelector(s) != null, sel)
const isOpen = () => has(`${TURN} .thimble-turn-call`)
const height = (sel: string) => box(sel).then((b) => b.height)
const focused = () => frame().evaluate(() => {
  const e = document.activeElement as HTMLElement
  return { cls: e.className, text: e.textContent, ring: getComputedStyle(e).boxShadow !== 'none' }
})

test("each turn gives a strip's loupe its time of day and its speaker as metadata", async () => {
  const got = await frame().evaluate(() => [...document.querySelectorAll('.thimble-turn')].map((e) => [e.getAttribute('data-time'), e.getAttribute('data-preview-meta')]))
  assert.deepEqual(got, [['09:00:00', 'user'], ['09:00:05', 'lead'], ['09:00:09', 'lead']])
})

test('the chevron at the start of a tool call\'s head opens it and folds it again, turned, where it was', async () => {
  assert.equal(await isOpen(), false)
  const caret = `${TURN} .thimble-turn-caret`
  const [shut, head] = [await box(caret), await box(`${TURN} .thimble-turn-head`)]
  assert.ok(Math.abs(shut.x - head.x) < 1, 'the chevron starts the head')
  const at = { x: shut.x + shut.width / 2, y: shut.y + shut.height / 2 }
  await page.mouse.click(at.x, at.y)
  assert.equal(await isOpen(), true)
  const open = await box(caret)
  assert.ok(Math.abs(open.x - shut.x) < 0.5 && Math.abs(open.y - shut.y) < 0.5, `the chevron stays in place (${shut.x},${shut.y} folded, ${open.x},${open.y} open)`)
  // turned down while open
  const turn = (sel: string) => frame().evaluate((s) => getComputedStyle(document.querySelector(s)!).transform, sel)
  assert.notEqual(await turn(caret), 'none')
  assert.equal(await has(`${TURN} [data-close]`), false)
  assert.equal(await frame().evaluate(() => document.getElementById('turns')!.textContent!.includes('Collapse')), false)
  // the same spot folds it
  await page.mouse.click(at.x, at.y)
  assert.equal(await isOpen(), false)
  assert.equal(await turn(caret), 'none')
  await page.mouse.click(at.x, at.y)
  assert.equal(await isOpen(), true)
})

test('a long result shows Show more under its cut text and Show less in the same place; the keyboard reaches both', async () => {
  const block = `${TURN} .thimble-turn-result`
  const more = `${TURN} .thimble-turn-more`
  const under = async () => {
    const [b, m] = [await box(block), await box(more)]
    return m.y - (b.y + b.height)
  }
  const label = () => frame().evaluate((s) => [document.querySelector(s)!.textContent, document.querySelector(s)!.getAttribute('aria-expanded')], more)
  const clipped = await height(block)
  assert.ok(clipped < 140, `the result shows ${clipped}px of its 30 lines`)
  assert.deepEqual(await label(), ['Show more', 'false'])
  const gap = await under()
  assert.ok(gap >= 0 && gap <= 4, `Show more sits under the cut text (${gap}px below it)`)
  const m = await box(more)
  await page.mouse.click(m.x + m.width / 2, m.y + m.height / 2)
  const whole = await height(block)
  assert.ok(whole > clipped * 3, `open, the result shows whole (${whole}px)`)
  assert.deepEqual(await label(), ['Show less', 'true'])
  const gapOpen = await under()
  assert.ok(Math.abs(gapOpen - gap) < 0.5, `Show less sits where Show more did, under the text (${gapOpen}px, ${gap}px)`)
  // the keyboard: Tab reaches Show less, ringed; Enter folds the result and the focus stays on its control
  await page.keyboard.press('Shift+Tab')
  await page.keyboard.press('Tab')
  assert.deepEqual(await focused(), { cls: 'thimble-turn-more', text: 'Show less', ring: true })
  await page.keyboard.press('Enter')
  assert.ok((await height(block)) < 140, 'Enter folds it again')
  assert.equal((await focused()).text, 'Show more')
  await page.keyboard.press('Enter')
  assert.ok((await height(block)) > clipped * 3, 'Enter opens it whole')
  // Shift+Tab reaches the head, ringed; Enter folds the turn and opens it again, the focus kept on the head
  await page.keyboard.press('Shift+Tab')
  const head = await focused()
  assert.deepEqual([head.cls, head.ring], ['thimble-turn-head thimble-turn-toggle', true])
  await page.keyboard.press('Enter')
  assert.equal(await isOpen(), false)
  assert.equal((await focused()).cls, 'thimble-turn-head thimble-turn-toggle')
  await page.keyboard.press('Enter')
  assert.equal(await isOpen(), true)
})
