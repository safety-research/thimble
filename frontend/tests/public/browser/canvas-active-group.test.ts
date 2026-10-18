// The frame the canvas reports as the analyst's active one (PUT /canvas/active-group, where a model's card with no group
// goes) is a frame the analyst pressed, never the frame of a card a ref opened: the canvas lands on a label's new card
// and selects it, which reported the label's group, so every later card main made with no group went into it (bug hunt
// L18). Drawn by the real Canvas in a real browser; a press on a card still reports its frame.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, test } from 'vitest'
import type { Browser, Page } from 'playwright'
import { bundle, cleanup, launch, ORIGIN, src } from './page.ts'

let browser: Browser
let page: Page
const reported: string[] = []

const TS = '2026-10-10T12:00:00+00:00'
const group = (id: string, title: string, parent: string | null) => ({ id, title, parent, kind: 'sequence', anchor: null, chat: null, role: 'analyst' })
const note = (id: string, notebook: string, n: number) => ({ id, notebook, kind: 'note', title: `How many spoons in drawer ${n}?`, takeaway: `Drawer ${n} holds ${n + 4} spoons.`, created_by: 'model', ts: TS, payload: { text: `Drawer ${n}.` }, text: `Drawer ${n}.` })
const CANVAS = {
  groups: [group('work', 'Your work', null), group('spoons', 'mentions a spoon', 'work')],
  cells: [note('w1', 'work', 1), note('s1', 'spoons', 2)],
}

beforeAll(async () => {
  const script = await bundle(
    'canvas-active-group',
    [
      `import '${src('styles/index.css')}'`,
      `import { createRoot } from 'react-dom/client'`,
      `import { Canvas } from '${src('canvas/Canvas.tsx')}'`,
      `import { teleport } from '${src('lib/teleport.ts')}'`,
      `;(window as unknown as { __teleport: typeof teleport }).__teleport = teleport`,
      `createRoot(document.getElementById('root')!).render(<Canvas ws="w" active={true} />)`,
    ],
    { loader: { '.css': 'css', '.woff2': 'empty', '.woff': 'empty' }, conditions: ['style'] },
  )
  const css = readFileSync(script.replace(/\.js$/, '.css'), 'utf8')
  browser = await launch()
  page = await browser.newPage({ viewport: { width: 1260, height: 950 } })
  await page.route('**/*', async (route) => {
    const req = route.request()
    const p = new URL(req.url()).pathname
    const json = (body: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
    if (p === '/bundle.css') return route.fulfill({ status: 200, contentType: 'text/css', body: css })
    if (p === '/api/ws/w/canvas/active-group' && req.method() === 'PUT') {
      const group = (JSON.parse(req.postData() ?? '{}') as { group: string }).group
      reported.push(group)
      return json({ group })
    }
    if (p === '/api/ws/w/canvas') return json(CANVAS)
    if (p === '/api/ws/w/canvas/comments') return json({ comments: [] })
    if (p === '/api/ws/w/chats' || p === '/api/ws/w/concepts' || p === '/api/ws/w/checks') return json([])
    if (p.startsWith('/api/')) return json({})
    return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/bundle.css"></head><body><div id="root" style="position:absolute;inset:0;display:flex"></div></body></html>' })
  })
  await page.goto(`${ORIGIN}/`)
  await page.addScriptTag({ path: script })
  await page.waitForSelector('[data-cell="s1"]')
  await page.waitForTimeout(300)
})

afterAll(async () => {
  await browser?.close()
  cleanup()
})

test("a card a ref opened is not the analyst's active frame; a card they press is", async () => {
  await page.evaluate(() => (window as unknown as { __teleport: (r: string) => void }).__teleport('card:s1'))
  await page.waitForTimeout(800)
  assert.ok(await page.$eval('[data-cell="s1"]', (el) => !!el.closest('.is-selected') || el.className.includes('is-selected') || !!el.querySelector('.is-selected')), 'the ref selects its card')
  assert.deepEqual(reported, [], 'the frame of the card a ref opened is not reported')
  // a press on the card's body, as the analyst selects a card
  const box = (await page.locator('[data-cell="w1"] .bcell-note').boundingBox())!
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
  await page.waitForTimeout(500)
  assert.deepEqual(reported, ['work'])
})
