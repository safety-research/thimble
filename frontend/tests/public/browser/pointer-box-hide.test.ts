// The ⌘-click box shows only while the element it is about is on screen (src/pointer/CmdPointer.tsx onScreen), in a
// real browser with thimble's own stylesheets. A switch to another tab hides it and its highlight, its text kept, and
// the Report's formatting toolbar shows again; back on the tab, the box is back beside its element with the text. The
// element taken off the page (a card a collapsed frame no longer draws) hides it, and the element drawn anew in its
// place, once the frame opens, brings it back beside the new element. A send under way while the box is hidden still
// finishes: the thread opens and the box is gone. A tester: "small bug: a comment in the canvas still shows when im in
// report view".
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, test } from 'vitest'
import type { Browser, Page } from 'playwright'
import { bundle, cleanup, launch, ORIGIN, src } from './page.ts'

let browser: Browser
let page: Page
let release: () => void = () => {}
const threads: unknown[] = []

beforeAll(async () => {
  const script = await bundle(
    'pointer-box-hide',
    [
      `import '${src('styles/index.css')}'`,
      `import { createRoot } from 'react-dom/client'`,
      `import { CmdPointer } from '${src('pointer/CmdPointer.tsx')}'`,
      `import { bus } from '${src('lib/bus.ts')}'`,
      `const w = window as any`,
      `w.__opened = []`,
      `bus.on('openChat', (e) => w.__opened.push(e.chatId))`,
      `w.__ask = (id) => bus.emit('askAbout', { el: document.getElementById(id) })`,
      `createRoot(document.getElementById('root')!).render(<CmdPointer ws="w" />)`,
    ],
    { loader: { '.css': 'css', '.woff2': 'empty', '.woff': 'empty' }, conditions: ['style'] },
  )
  const css = readFileSync(script.replace(/\.js$/, '.css'), 'utf8')
  browser = await launch()
  page = await browser.newPage({ viewport: { width: 1200, height: 800 } })
  await page.route('**/*', async (route) => {
    const req = route.request()
    const p = new URL(req.url()).pathname
    if (p === '/bundle.css') return route.fulfill({ status: 200, contentType: 'text/css', body: css })
    if (p === '/api/ws/w/chats' && req.method() === 'POST') {
      // the thread is made once the test lets it, so a send is under way meanwhile
      await new Promise<void>((r) => (release = r))
      threads.push(JSON.parse(req.postData() || '{}'))
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 't1', kind: 'thread', title: 'why' }) })
    }
    if (p.startsWith('/api/')) return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
    // two tabs as the shell draws them: the canvas with a card, and the report with its editor's formatting toolbar
    return route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/bundle.css"></head><body>
        <section id="canvas" data-panel="canvas" style="position:absolute;inset:0"><div id="a" data-anchor="card:a" style="position:absolute;left:100px;top:100px;width:300px;height:150px;border-radius:4px">Card a</div></section>
        <section id="report" data-panel="report" style="position:absolute;inset:0;display:none"><div class="bn-formatting-toolbar" style="position:absolute;left:100px;top:40px">B I U</div></section>
        <div id="root"></div></body></html>`,
    })
  })
  await page.goto(`${ORIGIN}/`)
  await page.addScriptTag({ path: script })
})

afterAll(async () => {
  release()
  await browser?.close()
  cleanup()
})

const frames = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(undefined)))))
/** Show one tab and hide the other, as a switch of tabs does. */
async function showTab(tab: 'canvas' | 'report') {
  await page.evaluate((t) => {
    document.getElementById('canvas')!.style.display = t === 'canvas' ? '' : 'none'
    document.getElementById('report')!.style.display = t === 'report' ? '' : 'none'
  }, tab)
  await frames()
  await page.waitForTimeout(100)
}
const boxShown = () => page.locator('.pointer-box').count().then((n) => n > 0)
const hlOn = () => page.evaluate(() => document.querySelector('.pointer-hl')?.hasAttribute('data-on') ?? false)
const rectOf = (sel: string) => page.evaluate((s) => document.querySelector<HTMLElement>(s)!.getBoundingClientRect().toJSON(), sel)

test('a switch to another tab hides the box and its highlight, keeping its text, and the toolbar shows', async () => {
  await page.evaluate(() => (window as any).__ask('a'))
  await page.waitForSelector('.pointer-box textarea')
  await page.fill('.pointer-box textarea', 'why is this so high')
  await frames()
  assert.ok(await hlOn(), 'the highlight marks the card')
  await showTab('report')
  assert.equal(await boxShown(), false, 'the box is not drawn over the report')
  assert.equal(await hlOn(), false, 'nor is the highlight')
  assert.notEqual(await page.evaluate(() => getComputedStyle(document.querySelector('.bn-formatting-toolbar')!).display), 'none', "the report's formatting toolbar shows")
})

test('back on the tab, the box is back beside its element with its text', async () => {
  await showTab('canvas')
  // a hidden box looks for its element a few times a second
  await page.waitForSelector('.pointer-box', { timeout: 2000 })
  assert.equal(await page.inputValue('.pointer-box textarea'), 'why is this so high')
  const a = await rectOf('#a')
  const b = await rectOf('.pointer-box')
  assert.ok(b.left >= a.right, `beside the card: ${b.left} vs ${a.right}`)
  assert.ok(await hlOn(), 'the highlight marks the card again')
})

test('the element taken off the page hides the box, and the element drawn anew brings it back beside it', async () => {
  // the card's frame collapses: the card is no longer drawn
  await page.evaluate(() => document.getElementById('a')!.remove())
  await frames()
  await page.waitForTimeout(100)
  assert.equal(await boxShown(), false)
  // the frame opens again: the card is drawn anew, somewhere else
  await page.evaluate(() => {
    const el = document.createElement('div')
    el.id = 'a2'
    el.setAttribute('data-anchor', 'card:a')
    el.style.cssText = 'position:absolute;left:500px;top:300px;width:300px;height:150px'
    el.textContent = 'Card a'
    document.getElementById('canvas')!.appendChild(el)
  })
  await page.waitForSelector('.pointer-box', { timeout: 2000 })
  await frames()
  assert.equal(await page.inputValue('.pointer-box textarea'), 'why is this so high')
  const a = await rectOf('#a2')
  const b = await rectOf('.pointer-box')
  assert.ok(b.left >= a.right && b.top >= a.top - 1 && b.top < a.bottom, `beside the card drawn anew: ${JSON.stringify({ a, b })}`)
  const hl = await rectOf('.pointer-hl')
  assert.ok(Math.abs(hl.left - a.left) < 4 && Math.abs(hl.top - a.top) < 4, `the highlight marks the card drawn anew: ${JSON.stringify(hl)}`)
})

test('a send under way while the box is hidden still finishes', async () => {
  await page.press('.pointer-box textarea', 'Enter')
  await page.waitForSelector('.pointer-box[aria-busy="true"]')
  await showTab('report')
  assert.equal(await boxShown(), false)
  release()
  await page.waitForFunction(() => (window as any).__opened.length > 0)
  assert.deepEqual(await page.evaluate(() => (window as any).__opened), ['t1'], 'the thread opens')
  assert.equal((threads[0] as { text: string; anchor: string }).text, 'why is this so high')
  assert.equal((threads[0] as { text: string; anchor: string }).anchor, 'card:a')
  await showTab('canvas')
  assert.equal(await boxShown(), false, 'the box is gone once its question is sent')
})
