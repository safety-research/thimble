// The view kit's Colour by with two choices, in a real browser (backend/app/viewer_bridge.js, viewer_colour.js): a page
// in a sandboxed frame lists records whose fields "kind" and "channel" are both choices, the first the colour and the
// second a track, and the bridge draws a band per choice on each record's left edge, side by side from the edge in the
// order of the strip's lanes, each in the colour of the record's value of that choice, and an empty place where the
// record has none, so the row's own background shows there. A record with room in its left padding has the bands
// there, behind its text; one whose text starts at its edge has them just outside it; one with a background image of
// its own has them inside, its gaps in its own colour. The pixels across each record's edge are read from a picture of
// the page. With one choice the bands give way to the one bar, and Off draws none. What the bands cost the paint is
// tests/public/browser/bridge-paint.test.ts; what they are without layout, tests/public/colour-kit.test.ts.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, test } from 'vitest'
import type { Browser, Frame, Page } from 'playwright'
import { cleanup, FRONTEND, launch } from './page.ts'

const APP = path.join(FRONTEND, '..', 'backend', 'app')
const read = (name: string) => readFileSync(path.join(APP, name), 'utf8')
const inline = (js: string) => js.replace(/<\/script/g, '<\\/script')
const BRIDGE = inline(read('viewer_bridge.js'))
const COLOUR = `window.__thimbleLabelOrder = ${read('label_order.json')}\n` + inline(read('viewer_colour.js'))
const KIT = read('viewer_kit.css')
const TOKENS =
  ':root{--label-1:#025ac3;--label-2:#d0750a;--label-3:#08632f;--label-5:#8a6d00;--label-13:#d0342c;--label-none:#a09c93;--ink-rgb:27,26,24;--surface-card:#fffdf8;' +
  '--text-primary:#000;--text-secondary:#4a4844;--text-tertiary:#726f69;--accent:#5135ff;--radius-chip:4px;--radius-ui:6px;' +
  '--h-row:28px;--control-sm:28px;--h-control:24px;--h-chip:20px;--text-xs:12px;--text-ui-sm:12px;--text-mono-sm:11px;--border-subtle:rgba(27,26,24,0.12);' +
  '--font-body:sans-serif;--font-mono:monospace}'
// each record: its line, its kind and its channel ('' for none); a list of each sort of row: `msg` with 12 px of left
// padding, `tight` with none (in a box 40 px in), `pic` with padding and a background image of its own
const RECS = [
  ['L1', 'Text only', 'ops'],
  ['L2', 'With links', 'wiki'],
  ['L3', '', 'ops'],
  ['L4', 'Text only', ''],
]
const view = `<!doctype html><html><head><style>${TOKENS} body{margin:0;font:12px sans-serif;background:#fff} .top{display:flex;align-items:center;gap:8px;padding:8px} .msg,.tight,.pic{box-sizing:border-box;height:30px;padding:6px 8px 0 12px} #out{margin-left:40px} .tight{padding-left:0} .pic{background-color:#eee;background-image:linear-gradient(#eee,#eee)}</style>
<script>window.__thimbleColour = ${JSON.stringify({ v: 1, by: 'f:kind', picks: ['f:kind', 'f:channel'], field: 'kind', off: {}, seen: [], colours: {} })}</script>
<script>${BRIDGE}</script><script>${COLOUR}</script><style>${KIT}</style></head><body>
<div class="top"><span id="colour"></span></div><div id="list"></div>
<script>
const RECS = ${JSON.stringify(RECS)}
const draw = (c) => (document.getElementById('list').innerHTML = ['msg', 'tight', 'pic'].map((cls) => '<div' + (cls === 'tight' ? ' id="out"' : '') + '>' + RECS.map(([l, kind, channel]) => '<div class="' + cls + '" data-anchor="' + cls + '.jsonl#' + l + '"' + c.attr({ kind, channel }) + '>' + cls + ' ' + l + '</div>').join('') + '</div>').join(''))
window.colour = thimble.colourBy({ mount: '#colour', fields: [{ name: 'kind', title: 'Kind', values: ['Text only', 'With links'] }, { name: 'channel', title: 'Channel', values: [{ name: 'ops', colour: 3 }, { name: 'wiki', colour: 5 }] }], onChange: (c) => draw(c) })
draw(window.colour)
</script></body></html>`

const BLUE = 'rgb(2, 90, 195)'
const ORANGE = 'rgb(208, 117, 10)'
const GREEN = 'rgb(8, 99, 47)'
const GOLD = 'rgb(138, 109, 0)'
const WHITE = 'rgb(255, 255, 255)'
const PIC = 'rgb(238, 238, 238)'

let browser: Browser
beforeAll(async () => {
  browser = await launch()
})
afterAll(async () => {
  await browser?.close()
  cleanup()
})

async function framed(): Promise<{ page: Page; frame: () => Frame }> {
  const page = await browser.newPage({ viewport: { width: 700, height: 600 }, deviceScaleFactor: 1 })
  await page.setContent('<!doctype html><html><body style="margin:0"><iframe id="f" sandbox="allow-scripts" style="border:0;width:600px;height:560px;display:block"></iframe></body></html>')
  await page.evaluate((doc) => ((document.getElementById('f') as HTMLIFrameElement).srcdoc = doc), view)
  const frame = () => page.frames().find((f) => f !== page.mainFrame())!
  await page.waitForFunction(() => (document.getElementById('f') as HTMLIFrameElement).contentWindow)
  await page.waitForTimeout(300)
  await frame().waitForFunction(() => document.querySelectorAll('[data-thimble-bands]').length === 12)
  await page.waitForTimeout(200)
  return { page, frame }
}

/** The colours across a record's left edge, from `from` px before it to `to` px after it, at its middle, read from a
 * picture of the page. */
async function across(page: Page, frame: Frame, ref: string, from = 8, to = 10): Promise<string[]> {
  const r = await frame.evaluate((ref) => {
    const b = document.querySelector(`[data-anchor="${ref}"]`)!.getBoundingClientRect()
    return { x: b.left, y: b.top + b.height / 2 }
  }, ref)
  const x = Math.max(0, Math.round(r.x) - from)
  const png = await page.screenshot({ clip: { x, y: Math.round(r.y), width: Math.round(r.x) + to - x, height: 1 } })
  const px = await page.evaluate(async (b64) => {
    const img = new Image()
    img.src = 'data:image/png;base64,' + b64
    await img.decode()
    const c = document.createElement('canvas')
    c.width = img.width
    c.height = 1
    const g = c.getContext('2d')!
    g.drawImage(img, 0, 0)
    const d = g.getImageData(0, 0, img.width, 1).data
    const out: string[] = []
    for (let i = 0; i < d.length; i += 4) out.push(`rgb(${d[i]}, ${d[i + 1]}, ${d[i + 2]})`)
    return out
  }, png.toString('base64'))
  // as many leading pixels as the record stood in from the page's edge, past `from`
  return [...Array(Math.max(0, from - Math.round(r.x))).fill(null), ...px]
}
/** `n` pixels of `colour` each, run after run. */
const runs = (...parts: [string, number][]) => parts.flatMap(([c, n]) => Array(n).fill(c))

test("two choices: a band per choice on each record's edge, in its value's colour of each, empty where it has none; in the padding, outside a record with none, inside one with an image of its own", async () => {
  const { page, frame } = await framed()
  const edges = await frame().evaluate(() => Object.fromEntries([...document.querySelectorAll('[data-anchor]')].map((e) => [e.getAttribute('data-anchor'), [e.getAttribute('data-thimble-edge'), e.hasAttribute('data-thimble-bar')]])))
  for (const l of ['L1', 'L2', 'L3', 'L4']) {
    assert.deepEqual(edges[`msg.jsonl#${l}`], ['bands', false], `msg ${l}: the bands in its padding, no bar`)
    assert.deepEqual(edges[`tight.jsonl#${l}`], ['bands-out', false], `tight ${l}: the bands outside it`)
    assert.deepEqual(edges[`pic.jsonl#${l}`], ['bands-in', false], `pic ${l}: the bands inside, as shadows`)
  }
  // in the padding: the first band at the edge, a pixel of the row's own background, the second, then the row
  const inside = async (ref: string) => (await across(page, frame(), ref, 0, 10)).slice(0, 10)
  assert.deepEqual(await inside('msg.jsonl#L1'), runs([BLUE, 3], [WHITE, 1], [GREEN, 3], [WHITE, 3]))
  assert.deepEqual(await inside('msg.jsonl#L2'), runs([ORANGE, 3], [WHITE, 1], [GOLD, 3], [WHITE, 3]))
  assert.deepEqual(await inside('msg.jsonl#L3'), runs([WHITE, 4], [GREEN, 3], [WHITE, 3]), 'no kind: an empty place, then the channel')
  assert.deepEqual(await inside('msg.jsonl#L4'), runs([BLUE, 3], [WHITE, 7]), 'no channel: the kind, then nothing')
  // an image of its own: the bands and their gaps over it, the gaps in its colour
  assert.deepEqual(await inside('pic.jsonl#L1'), runs([BLUE, 3], [PIC, 1], [GREEN, 3], [PIC, 3]))
  assert.deepEqual(await inside('pic.jsonl#L3'), runs([PIC, 4], [GREEN, 3], [PIC, 3]))
  // outside: the first band outermost, as the strip reads, the second against the record's edge
  const outside = async (ref: string) => await across(page, frame(), ref, 9, 0)
  assert.deepEqual(await outside('tight.jsonl#L1'), runs([WHITE, 2], [BLUE, 3], [WHITE, 1], [GREEN, 3]))
  assert.deepEqual(await outside('tight.jsonl#L3'), runs([WHITE, 6], [GREEN, 3]))
  assert.deepEqual(await outside('tight.jsonl#L4'), runs([WHITE, 2], [BLUE, 3], [WHITE, 4]))

  // Channel unchecked: one choice, the one bar again, and no band
  await frame().click('.thimble-colour-by')
  await frame().click('.thimble-colour-menu [data-by="f:channel"]')
  await frame().waitForFunction(() => !document.querySelector('[data-thimble-bands]') && document.querySelectorAll('[data-thimble-bar]').length === 9)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(150)
  assert.deepEqual(await inside('msg.jsonl#L1'), runs([BLUE, 3], [WHITE, 7]))
  assert.deepEqual(await inside('msg.jsonl#L3'), runs([WHITE, 10]))
  // Off: nothing on any edge
  await frame().click('.thimble-colour-by')
  await frame().click('.thimble-colour-menu [data-by="off"]')
  await frame().waitForFunction(() => !document.querySelector('[data-thimble-edge]'))
  await page.keyboard.press('Escape')
  await page.waitForTimeout(150)
  assert.deepEqual(await inside('msg.jsonl#L1'), runs([WHITE, 10]))
  await page.close()
}, 60_000)
