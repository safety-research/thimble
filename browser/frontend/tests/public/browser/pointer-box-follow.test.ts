// The ⌘-click box goes where the element it is about goes (src/pointer/CmdPointer.tsx), in a real browser with thimble's
// own stylesheets: when the element moves (the canvas panned or zoomed, the card laid out again), the box moves beside
// it with its text, and the focus stays where it is; when a pan takes the element out of the pane that clips it, the box
// hides, its text kept, and comes back once the element is in sight again; a popover opened over the page (Settings, a
// menu) hides the box and its highlight until it closes, Escape there being the popover's. Back, the box leaves the
// focus where it is, and takes it again only when it had it as it went and nothing has taken it since; Escape closes a
// box hidden off its pane.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, test } from 'vitest'
import type { Browser, Page } from 'playwright'
import { bundle, cleanup, launch, ORIGIN, src } from './page.ts'

let browser: Browser
let page: Page

beforeAll(async () => {
  const script = await bundle(
    'pointer-box-follow',
    [
      `import '${src('styles/index.css')}'`,
      `import { createRoot } from 'react-dom/client'`,
      `import { CmdPointer } from '${src('pointer/CmdPointer.tsx')}'`,
      `import { bus } from '${src('lib/bus.ts')}'`,
      `;(window as any).__ask = (id) => bus.emit('askAbout', { el: document.getElementById(id) })`,
      `createRoot(document.getElementById('root')!).render(<CmdPointer ws="w" />)`,
    ],
    { loader: { '.css': 'css', '.woff2': 'empty', '.woff': 'empty' }, conditions: ['style'] },
  )
  const css = readFileSync(script.replace(/\.js$/, '.css'), 'utf8')
  browser = await launch()
  page = await browser.newPage({ viewport: { width: 1200, height: 800 } })
  await page.route('**/*', async (route) => {
    const p = new URL(route.request().url()).pathname
    if (p === '/bundle.css') return route.fulfill({ status: 200, contentType: 'text/css', body: css })
    if (p.startsWith('/api/')) return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
    // a canvas pane that clips the board, with a card on it, and a field elsewhere on the page
    return route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/bundle.css"></head><body>
        <section id="canvas" data-panel="canvas" style="position:absolute;left:0;top:0;width:800px;height:600px;overflow:hidden"><div id="a" data-anchor="card:a" style="position:absolute;left:100px;top:100px;width:300px;height:150px;border-radius:4px">Card a</div></section>
        <textarea id="other" style="position:absolute;left:900px;top:700px"></textarea>
        <div id="root"></div></body></html>`,
    })
  })
  await page.goto(`${ORIGIN}/`)
  await page.addScriptTag({ path: script })
  // the box listens on the bus once CmdPointer has mounted, which a loaded machine can put after the script tag's load
  await page.waitForFunction(() => {
    if (document.querySelector('.pointer-box textarea')) return true
    ;(window as any).__ask('a')
    return false
  }, undefined, { polling: 200 })
  await page.fill('.pointer-box textarea', 'why is this so high')
})

afterAll(async () => {
  await browser?.close()
  cleanup()
})

const frames = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(undefined)))))
const moveCard = async (left: number, top: number) => {
  await page.evaluate(([l, t]) => Object.assign(document.getElementById('a')!.style, { left: `${l}px`, top: `${t}px` }), [left, top])
  await frames()
  await page.waitForTimeout(100)
}
const boxShown = () => page.locator('.pointer-box').count().then((n) => n > 0)
const focused = () => page.evaluate(() => (document.activeElement === document.querySelector('.pointer-box textarea') ? 'box' : document.activeElement?.id || document.activeElement?.tagName))
const hlOn = () => page.evaluate(() => document.querySelector('.pointer-hl')?.hasAttribute('data-on') ?? false)
const rectOf = (sel: string) => page.evaluate((s) => document.querySelector<HTMLElement>(s)!.getBoundingClientRect().toJSON(), sel)
const besideCard = async () => {
  const a = await rectOf('#a')
  const b = await rectOf('.pointer-box')
  return b.left >= a.right && b.top >= a.top - 1 && b.top < a.bottom
}

test('the box moves with its element, keeps its text, and leaves the focus where it is', async () => {
  await page.focus('#other')
  await moveCard(380, 260)
  assert.ok(await besideCard(), 'beside the card where it went')
  assert.equal(await page.inputValue('.pointer-box textarea'), 'why is this so high')
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'other', 'the field elsewhere keeps the focus')
  assert.ok(await hlOn(), 'the highlight marks the card')
})

test('a pan that takes the element out of its pane hides the box, and back in sight it comes back', async () => {
  await moveCard(900, 260)
  assert.equal(await boxShown(), false, 'no box beside a card panned off the board')
  assert.equal(await hlOn(), false)
  await moveCard(200, 160)
  // a hidden box looks for its element a few times a second
  await page.waitForSelector('.pointer-box', { timeout: 2000 })
  assert.ok(await besideCard(), 'beside the card again')
  assert.equal(await page.inputValue('.pointer-box textarea'), 'why is this so high')
  assert.equal(await focused(), 'other', 'the field elsewhere keeps the focus')
})

test('a popover opened over the page hides the box and its highlight until it closes', async () => {
  await page.evaluate(() => {
    const pop = document.createElement('div')
    pop.className = 'popover'
    pop.id = 'settings'
    pop.style.cssText = 'position:fixed;right:8px;top:40px;width:360px;height:300px'
    pop.textContent = 'Settings'
    document.body.appendChild(pop)
  })
  await frames()
  await page.waitForTimeout(100)
  assert.equal(await boxShown(), false, 'the box is not drawn over the popover')
  assert.equal(await hlOn(), false)
  // Escape is the popover's while it is open
  await page.keyboard.press('Escape')
  await page.evaluate(() => document.getElementById('settings')!.remove())
  await page.waitForSelector('.pointer-box', { timeout: 2000 })
  assert.ok(await besideCard())
  assert.equal(await page.inputValue('.pointer-box textarea'), 'why is this so high')
  assert.ok(await hlOn(), 'the highlight is back on the card')
  assert.equal(await focused(), 'other', 'the field elsewhere keeps the focus')
})

test('a box that had the focus as it went takes it back, unless the focus went to a field meanwhile', async () => {
  await page.focus('.pointer-box textarea')
  await moveCard(900, 260)
  assert.equal(await boxShown(), false)
  await moveCard(200, 160)
  await page.waitForSelector('.pointer-box', { timeout: 2000 })
  assert.equal(await focused(), 'box', 'the box takes back the focus it had')
  // gone again with the focus, while the analyst goes on in another field
  await moveCard(900, 260)
  await page.focus('#other')
  await page.keyboard.type(' and')
  await moveCard(200, 160)
  await page.waitForSelector('.pointer-box', { timeout: 2000 })
  assert.equal(await focused(), 'other', 'the field keeps the focus')
  assert.equal(await page.inputValue('#other'), ' and')
  assert.equal(await page.inputValue('.pointer-box textarea'), 'why is this so high')
})

test('Escape closes the box while a pan has hidden it', async () => {
  await moveCard(900, 260)
  assert.equal(await boxShown(), false)
  await page.keyboard.press('Escape')
  await moveCard(200, 160)
  // longer than a hidden box takes to find its element again
  await page.waitForTimeout(600)
  assert.equal(await boxShown(), false, 'the box does not come back')
  assert.equal(await hlOn(), false)
})
