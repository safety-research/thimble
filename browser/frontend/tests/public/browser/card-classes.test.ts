// thimble's card stylesheet (src/lib/cardStyle.ts) styles only the classes a page opts into with thimble's prefix, in a
// real browser: a custom card's page (src/canvas/DataViz.tsx CustomFrame) that names classes of its own `steps`,
// `label` and `value`, as models often do for a list of steps, keeps its own layout (a list down the card, no arrows,
// its type sizes), and a page that uses `tc-steps`, `tc-box`, `tc-label` and `tc-value` takes thimble's look.
import assert from 'node:assert/strict'
import { afterAll, beforeAll, test } from 'vitest'
import type { Browser, Frame, Page } from 'playwright'
import { bundle, cleanup, launch, ORIGIN, src } from './page.ts'

let browser: Browser
let page: Page

// a page with classes of its own: a vertical list of steps, each a label and its value
const OWN = `<style>
.steps{list-style:none;margin:0;padding:0}
.steps li{padding:6px 0;border-bottom:1px solid #e5e5e5}
.row{display:flex;justify-content:space-between;font-size:13px}
.label{color:#555}
.value{font-weight:600}
</style>
<ol class="steps" id="steps">
<li><div class="row"><span class="label" id="label">Scheduler starts the run</span><span class="value" id="value">02:00</span></div></li>
<li id="second"><div class="row"><span class="label">Build</span><span class="value">4 min</span></div></li>
</ol>`

// a page that opts into thimble's classes
const THIMBLE = `<div class="tc-steps" id="steps"><div class="tc-box"><div class="tc-label">Opened</div><div class="tc-value" id="value">412</div></div>
<div class="tc-box" id="second"><div class="tc-label">Merged</div><div class="tc-value">296</div></div></div>`

beforeAll(async () => {
  const script = await bundle('card-classes', [
    `import { createRoot } from 'react-dom/client'`,
    `import { CustomFrame } from '${src('canvas/DataViz.tsx')}'`,
    `const own = ${JSON.stringify(OWN)}`,
    `const thimble = ${JSON.stringify(THIMBLE)}`,
    `createRoot(document.getElementById('root')!).render(<div style={{ width: 700 }}><CustomFrame html={own} title="own" height={200} /><CustomFrame html={thimble} title="thimble" height={200} /></div>)`,
  ])
  browser = await launch()
  page = await browser.newPage({ viewport: { width: 900, height: 900 } })
  await page.route('**/*', (route) => {
    const p = new URL(route.request().url()).pathname
    if (p.startsWith('/api/')) return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
    return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div></body></html>' })
  })
  await page.goto(`${ORIGIN}/`)
  await page.addScriptTag({ path: script })
  await page.waitForFunction(() => document.querySelectorAll('.canvas-card-frame[data-settled="true"]').length === 2)
})

afterAll(async () => {
  await browser?.close()
  cleanup()
})

const frame = async (title: string): Promise<Frame> => (await (await page.$(`iframe[title="${title}"]`))!.contentFrame())!

/** The list's display, the arrow before its second part, and the value's font size, from the frame's computed styles. */
const look = (f: Frame) => f.evaluate(() => ({
  display: getComputedStyle(document.getElementById('steps')!).display,
  arrow: getComputedStyle(document.getElementById('second')!, '::before').content,
  value: getComputedStyle(document.getElementById('value')!).fontSize,
}))

test("a page's own `steps`, `label` and `value` take nothing of thimble's stylesheet: its list stays a list, with no arrows, in its own sizes", async () => {
  const f = await frame('own')
  assert.deepEqual(await look(f), { display: 'block', arrow: 'none', value: '13px' })
  assert.equal(await f.evaluate(() => getComputedStyle(document.getElementById('label')!).fontSize), '13px')
})

test("a page that opts into thimble's classes takes its look: the parts in a row with an arrow between them, the value large", async () => {
  assert.deepEqual(await look(await frame('thimble')), { display: 'flex', arrow: '"→"', value: '22px' })
})
