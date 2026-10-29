// thimble's card stylesheet (src/lib/cardStyle.ts) styles a page's plain HTML and no class, in a real browser: a custom
// card's page (src/canvas/DataViz.tsx CustomFrame) that names classes of its own `steps`, `label` and `value`, as models
// often do for a list of steps, keeps its own layout (a list down the card, its type sizes), and a page of plain HTML,
// a heading and a table with no class at all, takes thimble's look.
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

// a page of plain HTML, with no class at all
const PLAIN = `<h2 id="head">Queues under the target</h2>
<table id="table"><tr><th id="th">Queue</th><th>Answered within a day</th></tr>
<tr><td id="td">Refunds</td><td>82%</td></tr></table>
<small id="small">March</small>`

beforeAll(async () => {
  const script = await bundle('card-classes', [
    `import { createRoot } from 'react-dom/client'`,
    `import { CustomFrame } from '${src('canvas/DataViz.tsx')}'`,
    `const own = ${JSON.stringify(OWN)}`,
    `const plain = ${JSON.stringify(PLAIN)}`,
    `createRoot(document.getElementById('root')!).render(<div style={{ width: 700 }}><CustomFrame html={own} title="own" height={200} /><CustomFrame html={plain} title="plain" height={200} /></div>)`,
  ])
  browser = await launch()
  page = await browser.newPage({ viewport: { width: 900, height: 900 } })
  await page.route('**/*', (route) => {
    const p = new URL(route.request().url()).pathname
    if (p.startsWith('/api/')) return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
    // the paper's tokens a frame reads from the page (lib/frame frameTokens), made up
    return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><html><head><meta charset="utf-8"><style>:root{--text-primary:#202020;--text-secondary:#707070;--border-subtle:#d0d0d0}</style></head><body><div id="root"></div></body></html>' })
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

test("a page of plain HTML takes thimble's look with no class: the heading in the card's type, the table's head small in the secondary ink over a hairline", async () => {
  const f = await frame('plain')
  const got = await f.evaluate(() => {
    const css = (id: string) => getComputedStyle(document.getElementById(id)!)
    return {
      head: [css('head').fontSize, css('head').fontWeight],
      th: [css('th').fontSize, css('th').borderBottomStyle, css('th').borderBottomWidth],
      collapse: css('table').borderCollapse,
      secondary: css('th').color === css('small').color && css('th').color !== css('td').color,
    }
  })
  assert.deepEqual(got, { head: ['14px', '500'], th: ['12px', 'solid', '1px'], collapse: 'collapse', secondary: true })
})
