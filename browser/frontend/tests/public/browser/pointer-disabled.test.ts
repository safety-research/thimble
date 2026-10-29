// A ⌘-click on a disabled control opens the box as on any other element (src/pointer/CmdPointer.tsx). A browser sends a
// disabled button no mousedown, mouseup or click, only pointer events, so a label card's value, a button that cannot
// filter while its label runs over whole files, lit up under the pointer and opened nothing.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, test } from 'vitest'
import type { Browser, Page } from 'playwright'
import { bundle, cleanup, launch, ORIGIN, src } from './page.ts'

let browser: Browser
let script = ''
let css = ''

/** A page with a label card's value table, its value a disabled button, and the pointer (Ctrl off a Mac). */
async function open(): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } })
  await page.route('**/*', (route) => {
    const p = new URL(route.request().url()).pathname
    if (p === '/bundle.css') return route.fulfill({ status: 200, contentType: 'text/css', body: css })
    if (p.startsWith('/api/')) return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
    return route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/bundle.css"></head><body>
        <section data-panel="canvas"><div data-anchor="card:a" data-anchor-parts style="position:absolute;left:100px;top:100px;width:400px;height:200px;padding:20px">
          <table><thead><tr><th>value</th><th>files</th></tr></thead>
          <tbody><tr><td><button id="value" type="button" disabled style="width:160px;height:30px">refund</button></td><td>—</td></tr></tbody></table>
        </div></section>
        <div id="root"></div></body></html>`,
    })
  })
  await page.goto(`${ORIGIN}/`)
  await page.addScriptTag({ path: script })
  return page
}

beforeAll(async () => {
  script = await bundle(
    'pointer-disabled',
    [
      `import '${src('styles/index.css')}'`,
      `import { createRoot } from 'react-dom/client'`,
      `import { CmdPointer } from '${src('pointer/CmdPointer.tsx')}'`,
      `createRoot(document.getElementById('root')!).render(<CmdPointer ws="w" />)`,
    ],
    { loader: { '.css': 'css', '.woff2': 'empty', '.woff': 'empty' }, conditions: ['style'] },
  )
  css = readFileSync(script.replace(/\.js$/, '.css'), 'utf8')
  browser = await launch()
})

afterAll(async () => {
  await browser?.close()
  cleanup()
})

const boxes = (page: Page) => page.evaluate(() => document.querySelectorAll('.pointer-box').length)

test('a ⌘-click on a disabled button in a card opens the box about its row, once', async () => {
  const page = await open()
  const b = (await page.locator('#value').boundingBox())!
  await page.mouse.move(b.x + 20, b.y + 10)
  await page.keyboard.down('Control')
  await page.mouse.move(b.x + 30, b.y + 12)
  await page.mouse.click(b.x + 30, b.y + 12)
  await page.keyboard.up('Control')
  await page.waitForSelector('.pointer-box', { timeout: 2000 })
  await page.waitForTimeout(200)
  assert.equal(await boxes(page), 1)
  const held = await page.evaluate(() => {
    const hl = document.querySelector('.pointer-hl') as HTMLElement
    const row = document.querySelector('tbody tr')!.getBoundingClientRect()
    return { on: hl.hasAttribute('data-on'), w: parseFloat(hl.style.width), row: row.width }
  })
  assert.equal(held.on, true, 'the highlight holds')
  assert.ok(Math.abs(held.w - held.row) < 12, `on the row (${held.w} against ${held.row})`)
  await page.close()
})
