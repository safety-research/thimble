// A frozen demo session (src/chat/Precached.tsx) in headless Chromium: the card at the top of the orientation's thread
// gives the title, the sentence and the command, and the bar in place of the composer under the thread is hidden while
// the card is on screen, so they show once. Scrolled away from the card, the bar gives the sentence and the command
// again; scrolled back, it hides. What the card and the bar say is tests/public/precached.test.tsx.
import assert from 'node:assert/strict'
import { afterAll, beforeAll, test } from 'vitest'
import type { Browser, Page } from 'playwright'
import { bundle, cleanup, launch, ORIGIN, src } from './page.ts'

let browser: Browser
let script = ''

beforeAll(async () => {
  script = await bundle('precached-bar', [
    `import { createRoot } from 'react-dom/client'`,
    `import { AttachBar, PrecachedCard } from '${src('chat/Precached.tsx')}'`,
    `const mark = { dataset: 'collusion-wiki', created: '2026-10-06T01:00:00+00:00', folder: '/srv/thimble-demo/collusion-wiki', orientation: 'o1' }`,
    `const root = createRoot(document.getElementById('root')!)`,
    // the thread scrolls in its own box, the composer's place under it, as in the chat panel
    `root.render(<div style={{ display: 'flex', flexDirection: 'column', height: '500px' }}>`,
    `  <div id="thread" style={{ flex: '1 1 auto', overflow: 'auto' }}><PrecachedCard mark={mark} attached={false} /><div style={{ height: '2000px' }}>the orientation's transcript</div></div>`,
    `  <AttachBar mark={mark} card />`,
    `</div>)`,
  ])
  browser = await launch()
})

afterAll(async () => {
  await browser?.close()
  cleanup()
})

async function open(): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 700, height: 600 } })
  await page.route('**/*', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><html><head><meta charset="utf-8"><style>[hidden]{display:none}</style></head><body><div id="root"></div></body></html>' }))
  await page.goto(`${ORIGIN}/`)
  await page.addScriptTag({ path: script })
  await page.waitForSelector('[data-precached-bar]', { state: 'attached' })
  await page.waitForTimeout(150)
  return page
}

const shows = (page: Page) =>
  page.evaluate(() => {
    const bar = document.querySelector('[data-precached-bar]') as HTMLElement
    const text = (el: Element) => (el as HTMLElement).innerText
    return { bar: !bar.hidden && bar.getBoundingClientRect().height > 0, text: text(document.body) }
  })

test('the bar hides while the frozen card is on screen, and gives the sentence and the command once the card scrolls away', async () => {
  const page = await open()
  const top = await shows(page)
  assert.equal(top.bar, false, 'the card on screen: no bar')
  for (const said of ['This is a frozen demo session', 'To start a live session from scratch with this dataset, run', 'cd /srv/thimble-demo/collusion-wiki && thimble'])
    assert.equal(top.text.split(said).length, 2, `"${said}" shows once`)
  await page.evaluate(() => (document.getElementById('thread')!.scrollTop = 1500))
  await page.waitForTimeout(200)
  const away = await shows(page)
  assert.equal(away.bar, true, 'the card scrolled away: the bar')
  assert.match(await page.locator('[data-precached-bar]').innerText(), /To start a live session from scratch with this dataset, run[\s\S]*cd \/srv\/thimble-demo\/collusion-wiki && thimble/)
  await page.evaluate(() => (document.getElementById('thread')!.scrollTop = 0))
  await page.waitForTimeout(200)
  assert.equal((await shows(page)).bar, false, 'back at the card: no bar again')
  await page.close()
})
