// The chat's list under the composer, in a real browser's layout and paint (src/styles/chat.css), which jsdom cannot
// show. The composer floats over the list, so a chat taller than its column fades out just above it: nothing of the
// list shows under the composer or in the 8 px above it, also once typed text makes the composer taller, and the
// chat's last line still scrolls whole above the fade. A chat shorter than its column shows as it did without the fade.
// Two pictures of the page count as the same when no color differs by more than 2 of 255: a masked layer is composited
// with a rounding step of 1 here and there.
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { afterAll, beforeAll, test } from 'vitest'
import type { Browser, Page } from 'playwright'
import { bundle, cleanup, FRONTEND, launch, ORIGIN, src } from './page.ts'

// the chat column at its default width, on a 1024 px page
const WIDTH = 308
const HEIGHT = 560
const T = '2026-10-15T10:00:00+00:00'
const LAST = 'The last line of the answer.'
// more paragraphs than the column holds, then the last line
const LONG = [...Array.from({ length: 24 }, (_, i) => `Paragraph ${i + 1} of the answer, long enough to wrap onto a second line in the column.`), LAST].join('\n\n')
const SAME = 2

let browser: Browser
let script: string
let css: string

beforeAll(async () => {
  script = await bundle('chat-fade', [
    `import { createRoot } from 'react-dom/client'`,
    `import { ChatPanel } from '${src('chat/ChatPanel.tsx')}'`,
    `const column = document.createElement('div')`,
    `column.style.cssText = 'width: ${WIDTH}px; height: ${HEIGHT}px; margin: 20px'`,
    `document.body.appendChild(column)`,
    `createRoot(column).render(<ChatPanel ws="mini" />)`,
  ])
  // the page's one stylesheet with its faces in it, as the app loads them
  const sheet = await build({ entryPoints: [`${FRONTEND}/src/styles/index.css`], bundle: true, write: false, loader: { '.woff2': 'dataurl', '.woff': 'dataurl' }, logLevel: 'error' })
  css = sheet.outputFiles[0].text
  browser = await launch()
})

afterAll(async () => {
  await browser?.close()
  cleanup()
})

/** A page whose chat is main with the analyst's question and `answer`, which ends in LAST, its end in view. */
async function open(answer: string): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1024, height: HEIGHT + 40 } })
  const meta = { id: 'main', kind: 'main', role: 'main', title: 'main', created_at: T, parent: null, running: false, unread: [] }
  const events = [
    { type: 'user', ts: T, text: 'How did the runs end?', by: 'browser' },
    { type: 'text', delta: answer },
    { type: 'done', turn: 'aaaa1111' },
  ]
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url())
    if (url.protocol === 'data:') return route.continue()
    if (url.origin !== ORIGIN) return route.fulfill({ status: 404, body: '' })
    const json = (body: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
    const p = url.pathname
    if (p.endsWith('/chats/main')) return json({ meta, events })
    if (p.endsWith('/chats')) return json([meta])
    if (p.endsWith('/fixes')) return json({ problem: '', fixes: [] })
    if (p.endsWith('/settings')) return json({ models: {} })
    if (/\/(proposals|notices|views)$/.test(p)) return json([])
    if (p.startsWith('/api/')) return json({})
    return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0"></body></html>' })
  })
  await page.goto(`${ORIGIN}/?ws=mini`)
  await page.addStyleTag({ content: css })
  await page.addScriptTag({ path: script })
  await page.waitForFunction((last) => document.querySelector('.chat-list')?.textContent?.includes(last), LAST)
  await page.evaluate(() => document.fonts.ready)
  await settle(page)
  return page
}

/** Two frames: a resize is heard in the first and the list follows in the next. */
const settle = (page: Page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))

/** The most any color channel differs between two pictures of the same size. */
function differs(page: Page, a: Buffer, b: Buffer): Promise<number> {
  return page.evaluate(
    async ([a, b]) => {
      const pixels = async (png: string) => {
        const bitmap = await createImageBitmap(new Blob([Uint8Array.from(atob(png), (c) => c.charCodeAt(0))], { type: 'image/png' }))
        const g = new OffscreenCanvas(bitmap.width, bitmap.height).getContext('2d')!
        g.drawImage(bitmap, 0, 0)
        return g.getImageData(0, 0, bitmap.width, bitmap.height).data
      }
      const [pa, pb] = [await pixels(a), await pixels(b)]
      let most = 0
      for (let i = 0; i < pa.length; i++) most = Math.max(most, Math.abs(pa[i] - pb[i]))
      return most
    },
    [a.toString('base64'), b.toString('base64')],
  )
}

type Box = { x: number; y: number; width: number; height: number }

/** The list scrolled to `to` (its end, or halfway), with the foot's box: the composer and what rides with it, which
 * float over the list. */
async function scroll(page: Page, to: 'end' | 'half'): Promise<{ foot: Box; list: Box }> {
  await page.evaluate((to) => {
    const list = document.querySelector<HTMLElement>('.chat-list')!
    const end = list.scrollHeight - list.clientHeight
    list.scrollTop = to === 'end' ? end : end / 2
    list.dispatchEvent(new Event('scroll'))
  }, to)
  await settle(page)
  return page.evaluate(() => {
    const box = (el: Element) => {
      const r = el.getBoundingClientRect()
      return { x: r.x, y: r.y, width: r.width, height: r.height }
    }
    return { foot: box(document.querySelector('.chat-foot')!), list: box(document.querySelector('.chat-list')!) }
  })
}

const style = (page: Page, sel: string, prop: 'visibility' | 'maskImage', value: string) =>
  page.evaluate(([sel, prop, value]) => (document.querySelector<HTMLElement>(sel)!.style[prop as 'visibility'] = value), [sel, prop, value])

/** How much of the list shows under the composer or in the 8 px above it (a pixel of slack for the fade's last step),
 * the list scrolled halfway: that strip of the page with the composer hidden, against the same with the rows hidden
 * too. */
async function underBox(page: Page): Promise<number> {
  const { foot, list } = await scroll(page, 'half')
  const top = foot.y - 7
  const clip = { x: list.x, y: top, width: list.width, height: list.y + list.height - top }
  await style(page, '.chat-foot', 'visibility', 'hidden')
  const shown = await page.screenshot({ clip })
  await style(page, '.chat-flow', 'visibility', 'hidden')
  const none = await page.screenshot({ clip })
  await style(page, '.chat-flow', 'visibility', '')
  await style(page, '.chat-foot', 'visibility', '')
  return differs(page, shown, none)
}

/** The chat's last line at the list's end: how far its foot is above the composer, and how much it differs from the
 * same line with no fade on the list. */
async function lastLine(page: Page): Promise<{ clear: number; faded: number }> {
  const { foot } = await scroll(page, 'end')
  const line = await page.evaluate(() => {
    const texts = document.querySelectorAll('.chat-text')
    const walker = document.createTreeWalker(texts[texts.length - 1], NodeFilter.SHOW_TEXT)
    let last: Node | null = null
    for (let n = walker.nextNode(); n; n = walker.nextNode()) if (n.textContent?.trim()) last = n
    const range = document.createRange()
    range.selectNodeContents(last!)
    const rects = range.getClientRects()
    const r = rects[rects.length - 1]
    return { x: r.x, y: r.y, width: r.width, height: r.height }
  })
  const clip = { x: line.x - 2, y: line.y - 2, width: line.width + 4, height: line.height + 4 }
  const shot = await page.screenshot({ clip })
  await style(page, '.chat-list', 'maskImage', 'none')
  const bare = await page.screenshot({ clip })
  await style(page, '.chat-list', 'maskImage', '')
  return { clear: foot.y - (line.y + line.height), faded: await differs(page, shot, bare) }
}

test("a long chat's rows fade out above the composer, as it grows with typed text, and its last line shows whole", async () => {
  const page = await open(LONG)
  assert.ok((await underBox(page)) <= SAME, 'the list shows under the composer')
  const before = await lastLine(page)
  assert.ok(before.clear >= 24 - 0.5, `the last line is ${before.clear}px above the composer`)
  assert.ok(before.faded <= SAME, 'the last line is faded')

  // six lines typed: the composer grows, and the fade with it
  const short = await page.evaluate(() => document.querySelector('.chat-foot')!.getBoundingClientRect().height)
  await page.click('.chat-composer textarea')
  for (let i = 1; i <= 6; i++) {
    if (i > 1) await page.keyboard.press('Shift+Enter')
    await page.keyboard.type(`line ${i} of a longer question`)
  }
  await settle(page)
  const tall = await page.evaluate(() => document.querySelector('.chat-foot')!.getBoundingClientRect().height)
  assert.ok(tall > short + 60, `the composer grew from ${short}px to ${tall}px`)
  assert.ok((await underBox(page)) <= SAME, 'the list shows under the taller composer')
  const after = await lastLine(page)
  assert.ok(after.clear >= 24 - 0.5, `the last line is ${after.clear}px above the taller composer`)
  assert.ok(after.faded <= SAME, 'the last line is faded above the taller composer')
  await page.close()
})

test('a chat shorter than its column shows as it does with no fade', async () => {
  const page = await open(LAST)
  const fits = await page.evaluate(() => {
    const list = document.querySelector<HTMLElement>('.chat-list')!
    return list.scrollHeight <= list.clientHeight
  })
  assert.equal(fits, true)
  const clip = { x: 20, y: 20, width: WIDTH, height: HEIGHT }
  const shot = await page.screenshot({ clip })
  await style(page, '.chat-list', 'maskImage', 'none')
  assert.ok((await differs(page, shot, await page.screenshot({ clip }))) <= SAME)
  await page.close()
})
