// The ask key Settings picks (src/lib/platform.ts, src/pointer/CmdPointer.tsx), in a real browser: with ⌥ picked, ⌥
// does what ⌘ did. On a Mac the pointer and its highlight show once ⌥ has been held alone for about 300 ms, a key
// pressed with ⌥ (⌥E types an accent) turns them off until ⌥ is released, and an ⌥-click opens the box at once; ⌘ held
// or a ⌘-click does nothing there. Off a Mac, Alt shows them at once and Ctrl does not. With ⌘ picked again, ⌘ asks as
// before. The page takes a new choice at once (setAskKey, as Settings' Save calls it).
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, test } from 'vitest'
import type { Browser, Page } from 'playwright'
import { bundle, cleanup, launch, ORIGIN, src } from './page.ts'

let browser: Browser
let script = ''
let css = ''

/** A page with a card the pointer can point at, reporting a Mac or not, with ⌥ picked as the ask key. */
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
  await page.evaluate(() => (window as unknown as { setAskKey: (k: string) => void }).setAskKey('alt'))
  await page.mouse.move(250, 175)
  return page
}

beforeAll(async () => {
  script = await bundle(
    'pointer-ask-key',
    [
      `import '${src('styles/index.css')}'`,
      `import { createRoot } from 'react-dom/client'`,
      `import { CmdPointer } from '${src('pointer/CmdPointer.tsx')}'`,
      `import { setAskKey } from '${src('lib/platform.ts')}'`,
      `;(window as unknown as { setAskKey: typeof setAskKey }).setAskKey = setAskKey`,
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

/** Whether the pointer is on (the accent arrow) and the highlight shows. */
const pointer = (page: Page) => page.evaluate(() => ({ on: document.body.hasAttribute('data-cmd'), hl: document.querySelector('.pointer-hl')?.hasAttribute('data-on') ?? false }))
const boxOpen = (page: Page) => page.evaluate(() => !!document.querySelector('.pointer-box'))

test('on a Mac with ⌥ picked, ⌥ held alone shows the pointer after about 300 ms, and a key pressed with it turns it off', async () => {
  const page = await open(true)
  await page.keyboard.down('Alt')
  await page.waitForTimeout(100)
  assert.deepEqual(await pointer(page), { on: false, hl: false }, 'not yet')
  await page.waitForTimeout(350)
  assert.deepEqual(await pointer(page), { on: true, hl: true }, 'shown, on the card under the pointer')
  await page.keyboard.press('KeyE')
  assert.deepEqual(await pointer(page), { on: false, hl: false }, '⌥E turns it off')
  await page.mouse.move(260, 180)
  await page.waitForTimeout(450)
  assert.deepEqual(await pointer(page), { on: false, hl: false }, 'and it stays off while ⌥ is held')
  await page.keyboard.up('Alt')
  await page.close()
})

test('on a Mac with ⌥ picked, ⌘ held shows nothing and a ⌘-click opens no box; an ⌥-click opens it at once', async () => {
  const page = await open(true)
  await page.keyboard.down('Meta')
  await page.waitForTimeout(450)
  assert.deepEqual(await pointer(page), { on: false, hl: false })
  await page.mouse.click(250, 175)
  await page.keyboard.up('Meta')
  await page.waitForTimeout(200)
  assert.equal(await boxOpen(page), false, 'a ⌘-click is no ask')
  await page.keyboard.down('Alt')
  await page.mouse.click(250, 175)
  await page.keyboard.up('Alt')
  await page.waitForSelector('.pointer-box', { timeout: 2000 })
  await page.close()
})

test('off a Mac with ⌥ picked, Alt shows the pointer at once and Ctrl does not', async () => {
  const page = await open(false)
  await page.keyboard.down('Control')
  await page.mouse.move(255, 178)
  assert.deepEqual(await pointer(page), { on: false, hl: false })
  await page.keyboard.up('Control')
  await page.keyboard.down('Alt')
  await page.mouse.move(258, 180)
  assert.deepEqual(await pointer(page), { on: true, hl: true })
  await page.keyboard.up('Alt')
  await page.close()
})

test('with ⌘ picked again, ⌘ asks and ⌥ does not', async () => {
  const page = await open(true)
  await page.evaluate(() => (window as unknown as { setAskKey: (k: string) => void }).setAskKey('meta'))
  await page.keyboard.down('Alt')
  await page.waitForTimeout(450)
  assert.deepEqual(await pointer(page), { on: false, hl: false }, '⌥ no longer points')
  await page.keyboard.up('Alt')
  await page.keyboard.down('Meta')
  await page.waitForTimeout(450)
  assert.deepEqual(await pointer(page), { on: true, hl: true }, '⌘ does')
  await page.keyboard.up('Meta')
  await page.close()
})
