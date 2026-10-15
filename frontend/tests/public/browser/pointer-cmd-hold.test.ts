// ⌘ and the shortcuts that share it on a Mac (src/pointer/CmdPointer.tsx HOLD_MS), in a real browser that reports a
// Mac: the pointer and its highlight show only once ⌘ has been held alone for about 300 ms, at what the pointer is
// over; a key pressed with ⌘ (⌘C, ⌘V) turns them off until ⌘ is released, and a key pressed before then keeps them
// off; a ⌘-click opens the box at once. Off a Mac, Ctrl still shows them at once. A tester: "the command key for most
// ppl is for copy pasting i think".
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, test } from 'vitest'
import type { Browser, Page } from 'playwright'
import { bundle, cleanup, launch, ORIGIN, src } from './page.ts'

let browser: Browser
let script = ''
let css = ''

/** A page with a card the pointer can point at, reporting a Mac or not. */
async function open(mac: boolean): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } })
  if (mac)
    await page.addInitScript(() => {
      Object.defineProperty(Navigator.prototype, 'platform', { get: () => 'MacIntel' })
      Object.defineProperty(Navigator.prototype, 'userAgentData', { get: () => ({ platform: 'macOS' }) })
    })
  await page.route('**/*', (route) => {
    const p = new URL(route.request().url()).pathname
    if (p === '/bundle.css') return route.fulfill({ status: 200, contentType: 'text/css', body: css })
    if (p.startsWith('/api/')) return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
    return route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/bundle.css"></head><body>
        <section data-panel="canvas"><div data-anchor="card:a" style="position:absolute;left:100px;top:100px;width:300px;height:150px"></div></section>
        <div id="root"></div></body></html>`,
    })
  })
  await page.goto(`${ORIGIN}/`)
  await page.addScriptTag({ path: script })
  await page.mouse.move(250, 175)
  return page
}

beforeAll(async () => {
  script = await bundle(
    'pointer-cmd-hold',
    [`import '${src('styles/index.css')}'`, `import { createRoot } from 'react-dom/client'`, `import { CmdPointer } from '${src('pointer/CmdPointer.tsx')}'`, `createRoot(document.getElementById('root')!).render(<CmdPointer ws="w" />)`],
    { loader: { '.css': 'css', '.woff2': 'empty', '.woff': 'empty' }, conditions: ['style'] },
  )
  css = readFileSync(script.replace(/\.js$/, '.css'), 'utf8')
  browser = await launch()
})

afterAll(async () => {
  await browser?.close()
  cleanup()
})

/** Whether the ⌘ pointer is on (the accent arrow) and the highlight shows. */
const pointer = (page: Page) => page.evaluate(() => ({ on: document.body.hasAttribute('data-cmd'), hl: document.querySelector('.pointer-hl')?.hasAttribute('data-on') ?? false }))

test('on a Mac the pointer and its highlight show once ⌘ has been held alone for about 300 ms', async () => {
  const page = await open(true)
  await page.keyboard.down('Meta')
  await page.waitForTimeout(100)
  assert.deepEqual(await pointer(page), { on: false, hl: false }, 'not yet')
  await page.waitForTimeout(350)
  assert.deepEqual(await pointer(page), { on: true, hl: true }, 'shown, on the card under the pointer, with no move')
  await page.keyboard.up('Meta')
  assert.equal((await pointer(page)).on, false)
  await page.close()
})

test('on a Mac a key pressed with ⌘ turns them off until ⌘ is released', async () => {
  const page = await open(true)
  await page.keyboard.down('Meta')
  await page.waitForTimeout(450)
  assert.deepEqual(await pointer(page), { on: true, hl: true })
  await page.keyboard.press('KeyC')
  assert.deepEqual(await pointer(page), { on: false, hl: false }, '⌘C turns them off')
  await page.mouse.move(260, 180)
  await page.waitForTimeout(450)
  assert.deepEqual(await pointer(page), { on: false, hl: false }, 'and they stay off while ⌘ is held')
  await page.keyboard.up('Meta')
  await page.keyboard.down('Meta')
  await page.waitForTimeout(450)
  assert.deepEqual(await pointer(page), { on: true, hl: true }, '⌘ held alone again shows them')
  await page.keyboard.up('Meta')
  await page.close()
})

test('on a Mac a shortcut pressed quickly never shows them', async () => {
  const page = await open(true)
  await page.keyboard.down('Meta')
  await page.keyboard.press('KeyV')
  await page.mouse.move(260, 180)
  await page.waitForTimeout(450)
  assert.deepEqual(await pointer(page), { on: false, hl: false })
  await page.keyboard.up('Meta')
  await page.close()
})

test('on a Mac a ⌘-click opens the box at once', async () => {
  const page = await open(true)
  await page.keyboard.down('Meta')
  await page.mouse.click(250, 175)
  await page.keyboard.up('Meta')
  await page.waitForSelector('.pointer-box', { timeout: 2000 })
  await page.close()
})

test('off a Mac Ctrl shows them at once', async () => {
  const page = await open(false)
  await page.keyboard.down('Control')
  await page.mouse.move(255, 178)
  assert.deepEqual(await pointer(page), { on: true, hl: true })
  await page.keyboard.press('KeyC')
  assert.equal((await pointer(page)).on, false, 'and Ctrl+C turns them off')
  await page.keyboard.up('Control')
  await page.close()
})
