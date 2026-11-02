// The ⌘-click box keeps clear of the controls that float over a pane (src/pointer/PointerBox.tsx FLOATING), in a real
// browser with thimble's own stylesheets: beside a card at the top of the board, under the board's bar (Card, Group,
// Comments) rather than over it, and still beside the card; with the bar not drawn, where it always went.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, test } from 'vitest'
import type { Browser, Page } from 'playwright'
import { bundle, cleanup, launch, ORIGIN, src } from './page.ts'

let browser: Browser
let page: Page

beforeAll(async () => {
  const script = await bundle(
    'pointer-box-clear',
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
    // a canvas pane with its bar at the top right, as the board's controls float there, and a card at its top
    return route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/bundle.css"></head><body>
        <section data-panel="canvas" style="position:absolute;left:0;top:0;width:800px;height:600px;overflow:hidden">
          <div id="a" data-anchor="card:a" style="position:absolute;left:100px;top:20px;width:500px;height:150px">Card a</div>
          <div id="bar" data-floating style="position:absolute;right:10px;top:14px;width:150px;height:34px">Card · Group · Comments</div>
        </section>
        <div id="root"></div></body></html>`,
    })
  })
  await page.goto(`${ORIGIN}/`)
  await page.addScriptTag({ path: script })
})

afterAll(async () => {
  await browser?.close()
  cleanup()
})

const rectOf = (sel: string) => page.evaluate((s) => document.querySelector<HTMLElement>(s)!.getBoundingClientRect().toJSON(), sel)
const meet = (a: DOMRect, b: DOMRect) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top
const ask = async () => {
  await page.evaluate(() => document.querySelector('.pointer-box')?.remove())
  // the box listens on the bus once CmdPointer has mounted, which a loaded machine can put after the script tag's load
  await page.waitForFunction(() => {
    if (document.querySelector('.pointer-box textarea')) return true
    ;(window as any).__ask('a')
    return false
  }, undefined, { polling: 200 })
  return rectOf('.pointer-box')
}

test('beside a card at the top of the board, the box goes under the bar, still beside the card', async () => {
  const [box, bar, card] = [await ask(), await rectOf('#bar'), await rectOf('#a')]
  assert.equal(meet(box, bar), false, `the box ${JSON.stringify(box)} covers the bar ${JSON.stringify(bar)}`)
  assert.ok(box.left >= card.right && box.top >= bar.bottom && box.top < card.bottom, 'beside the card, under the bar')
})

test('with the bar not drawn, the box goes where it always went', async () => {
  await page.keyboard.press('Escape')
  await page.evaluate(() => (document.getElementById('bar')!.style.display = 'none'))
  const [box, card] = [await ask(), await rectOf('#a')]
  assert.ok(box.left >= card.right && Math.abs(box.top - (card.top + 8)) < 1, `beside the card's top: ${JSON.stringify(box)}`)
})
