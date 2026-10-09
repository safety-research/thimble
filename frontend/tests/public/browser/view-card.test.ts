// The view kit's record card (backend/app/viewer_kit.css .thimble-card, viewer_colour.js thimble.recordCard), in a real
// browser: a page in a sandboxed frame draws records as cards in a column and colors them by a field with the kit's
// Color by. A card is a hairline box on the paper with the chip token's corners and no colour of its own; Color by's
// bar is its only colour, drawn by the bridge on its left edge, and the card's left corners go square under it, so the
// bar is as straight at the card's top as at its middle. With Off the card has no bar and its corners are all the
// token's again. The pixels across each card's edge are read from a picture of the page. What recordCard writes,
// without layout, is tests/public/record-card.test.ts.
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
  ':root{--label-1:#025ac3;--label-2:#d0750a;--label-3:#08632f;--label-none:#a09c93;--ink-rgb:27,26,24;--surface-card:#ffffff;' +
  '--text-primary:#000;--text-secondary:#4a4844;--text-tertiary:#726f69;--accent:#5135ff;--radius-chip:4px;--radius-ui:6px;--radius-card:8px;' +
  '--h-row:28px;--control-sm:28px;--h-control:24px;--h-chip:20px;--text-xs:12px;--text-ui-sm:12px;--text-mono-sm:11px;' +
  '--border-subtle:rgba(27,26,24,0.12);--border-strong:rgba(27,26,24,0.22);--font-body:sans-serif;--font-mono:monospace}'
const PRS = [
  { number: 66599, ref: 'forge.db#prs/66599', claimant: 'agent-08', title: 'DOC: fix url in concat docs to copy-on-write' },
  { number: 66191, ref: 'forge.db#prs/66191', claimant: 'agent-21', title: 'BUG: rolling window behavior with offsets' },
  { number: 66047, ref: 'forge.db#prs/66047', claimant: '', title: 'BUG: fix plotting with tz-aware index' },
]
const view = `<!doctype html><html><head><style>${TOKENS} body{margin:0;font:12px sans-serif;background:#f0f0f0} .top{display:flex;align-items:center;gap:8px;padding:8px} #col{width:240px;margin:8px 16px}</style>
<script>${BRIDGE}</script><script>${COLOUR}</script><style>${KIT}</style></head><body>
<div class="top"><span id="colour"></span></div><div id="col" class="thimble-cards"></div>
<script>
const PRS = ${JSON.stringify(PRS)}
const draw = () => (document.getElementById('col').innerHTML = PRS.map((pr) => thimble.recordCard({ ref: pr.ref, record: pr, key: '#' + pr.number, chips: [pr.claimant], title: pr.title })).join(''))
window.colour = thimble.colourBy({ mount: '#colour', fields: [{ name: 'claimant', title: 'Claimant', values: ['agent-08', 'agent-21'] }], onChange: draw })
draw()
</script></body></html>`

const BLUE = 'rgb(2, 90, 195)'
const ORANGE = 'rgb(208, 117, 10)'
const WHITE = 'rgb(255, 255, 255)'

let browser: Browser
beforeAll(async () => {
  browser = await launch()
})
afterAll(async () => {
  await browser?.close()
  cleanup()
})

async function framed(): Promise<{ page: Page; frame: () => Frame }> {
  const page = await browser.newPage({ viewport: { width: 500, height: 400 }, deviceScaleFactor: 1 })
  await page.setContent('<!doctype html><html><body style="margin:0"><iframe id="f" sandbox="allow-scripts" style="border:0;width:400px;height:360px;display:block"></iframe></body></html>')
  await page.evaluate((doc) => ((document.getElementById('f') as HTMLIFrameElement).srcdoc = doc), view)
  const frame = () => page.frames().find((f) => f !== page.mainFrame())!
  await page.waitForFunction(() => (document.getElementById('f') as HTMLIFrameElement).contentWindow)
  await page.waitForTimeout(300)
  await frame().waitForFunction(() => document.querySelectorAll('.thimble-card[data-thimble-edge]').length === 2)
  await page.waitForTimeout(200)
  return { page, frame }
}

/** The colours of the `n` pixels from a card's left edge inward, `dy` px below its top (null: at its middle), read
 * from a picture of the page. */
async function edge(page: Page, frame: Frame, ref: string, dy: number | null, n = 6): Promise<string[]> {
  const r = await frame.evaluate(([ref, dy]) => {
    const b = document.querySelector(`[data-anchor="${ref}"]`)!.getBoundingClientRect()
    return { x: b.left, y: dy == null ? b.top + b.height / 2 : b.top + (dy as number) }
  }, [ref, dy] as const)
  const png = await page.screenshot({ clip: { x: Math.round(r.x), y: Math.floor(r.y), width: n, height: 1 } })
  return page.evaluate(async (b64) => {
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
}

/** A card's look as the browser computes it. */
const look = (frame: Frame, ref: string) =>
  frame.evaluate((ref) => {
    const cs = getComputedStyle(document.querySelector(`[data-anchor="${ref}"]`)!)
    return {
      radius: [cs.borderTopLeftRadius, cs.borderTopRightRadius, cs.borderBottomRightRadius, cs.borderBottomLeftRadius],
      left: cs.borderLeftWidth,
      right: cs.borderRightWidth,
      bg: cs.backgroundColor,
      token: getComputedStyle(document.documentElement).getPropertyValue('--radius-chip').trim(),
    }
  }, ref)

test("a card has the chip token's corners, a hairline edge and the paper; Color by's bar is straight on its left edge, and Off draws none", async () => {
  const { page, frame } = await framed()
  // colored: the bar on the left edge, inside the hairline, the left corners square under it
  const hot = await look(frame(), 'forge.db#prs/66599')
  assert.deepEqual(hot.radius, ['0px', '4px', '4px', '0px'], 'square on the left under the bar, the token on the right')
  assert.equal(hot.left, '1px', 'a hairline on the left, as on every side: no stripe of its own')
  assert.equal(hot.right, '1px')
  assert.equal(hot.bg, WHITE, 'the paper')
  for (const [ref, colour] of [['forge.db#prs/66599', BLUE], ['forge.db#prs/66191', ORANGE]] as const) {
    const middle = await edge(page, frame(), ref, null)
    assert.deepEqual(middle.slice(1, 5), [colour, colour, colour, WHITE], `${ref}: three pixels of its value's colour inside the hairline, then the paper`)
    assert.deepEqual(await edge(page, frame(), ref, 1), middle, `${ref}: the bar as straight just under the card's top as at its middle`)
  }
  // a record with no value: no bar, the token's corners all round
  const none = await look(frame(), 'forge.db#prs/66047')
  assert.deepEqual(none.radius, Array(4).fill(none.token), 'no value: the chip token on every corner')
  assert.ok(!(await edge(page, frame(), 'forge.db#prs/66047', null)).slice(1, 4).some((c) => c === BLUE || c === ORANGE))

  // Off: no bar on any card, every corner the token's
  await frame().click('.thimble-colour-by')
  await frame().click('.thimble-colour-menu [data-by="off"]')
  await frame().waitForFunction(() => !document.querySelector('[data-thimble-edge]'))
  await page.keyboard.press('Escape')
  await page.waitForTimeout(200)
  for (const pr of PRS) {
    const l = await look(frame(), pr.ref)
    assert.deepEqual(l.radius, Array(4).fill('4px'), `${pr.ref}: the token's corners with Off`)
    assert.deepEqual((await edge(page, frame(), pr.ref, null)).slice(1, 4), [WHITE, WHITE, WHITE], `${pr.ref}: no bar with Off`)
  }
  await page.close()
}, 60_000)
