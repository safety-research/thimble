// ⌘ on a Mac (src/pointer/CmdPointer.tsx), in a real browser that reports a Mac: a ⌘-click opens the ask box at once.
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
        <div id="zone" style="position:absolute;left:100px;top:400px"><textarea id="ta">Latency rose on the second day.</textarea></div>
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
    [
      `import '${src('styles/index.css')}'`,
      `import { createRoot } from 'react-dom/client'`,
      `import { CmdPointer } from '${src('pointer/CmdPointer.tsx')}'`,
      `import { addAgentZone, tintElement } from '${src('lib/agentKey.ts')}'`,
      // text that ⌘↵ sends while the caret is in it, tinted through data-agent as the report's blocks are
      `const ta = () => document.getElementById('ta')`,
      `addAgentZone(document.getElementById('zone')!, () => (document.activeElement === ta() ? { tint: tintElement(ta), send: () => {} } : null))`,
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

test('on a Mac a ⌘-click opens the box at once', async () => {
  const page = await open(true)
  await page.keyboard.down('Meta')
  await page.mouse.click(250, 175)
  await page.keyboard.up('Meta')
  await page.waitForSelector('.pointer-box', { timeout: 2000 })
  await page.close()
})
