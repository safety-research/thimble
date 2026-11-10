// Long names in the chat, in a real browser's layout (src/styles/chat.css), which jsdom cannot show. A subagent's chip
// whose name is wider than the chat starts the name at its left edge and ends it in … (a bare button centers its words,
// so live check br19 saw the names cut at the left), and a side thread's line, such as a fix's, shows its thread's
// whole name, over a second line in its chip when one line is too short for it.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, test } from 'vitest'
import type { Browser, Page } from 'playwright'
import { bundle, cleanup, FRONTEND, launch, ORIGIN, src } from './page.ts'

const NAME = "fixing make the composer's placeholder say Ask…"
const WIDTH = 240

let browser: Browser
let page: Page

beforeAll(async () => {
  const script = await bundle('chat-names', [
    `import { createRoot } from 'react-dom/client'`,
    `import { flushSync } from 'react-dom'`,
    `import { Rows } from '${src('chat/Rows.tsx')}'`,
    `import { ThreadsContext } from '${src('chat/Notes.tsx')}'`,
    `const name = ${JSON.stringify(NAME)}`,
    // a fix's line in main, and a subagent of main's with as long a name
    `const rows = [{ kind: 'agent', index: 1, chat: 'f1', role: 'fixer', title: name }, { kind: 'agent', index: 2, chat: 's9', role: 'subagent', title: name }]`,
    `const ctx = { labels: new Map([['f1', 'main/' + name]]), metas: new Map([['f1', { id: 'f1', kind: 'agent', role: 'fixer', title: name, status: 'running' }]]) }`,
    `const el = document.createElement('div')`,
    `el.style.width = '${WIDTH}px'`,
    `document.body.appendChild(el)`,
    `flushSync(() => createRoot(el).render(<ThreadsContext.Provider value={ctx}><Rows rows={rows} ws="mini" /></ThreadsContext.Provider>))`,
  ])
  browser = await launch()
  page = await browser.newPage()
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url())
    if (url.origin !== ORIGIN) return route.fulfill({ status: 404, body: '' })
    const json = (body: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
    if (url.pathname.endsWith('/chats/s9')) return json({ meta: { id: 's9', kind: 'agent', role: 'subagent', title: NAME, status: 'done' }, events: [] })
    if (url.pathname.startsWith('/api/')) return json([])
    return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>' })
  })
  await page.goto(`${ORIGIN}/?ws=mini`)
  for (const sheet of ['tokens.css', 'base.css', 'components.css', 'spinner.css', 'chat.css']) {
    await page.addStyleTag({ content: readFileSync(`${FRONTEND}/src/styles/${sheet}`, 'utf8') })
  }
  await page.addScriptTag({ path: script })
  await page.waitForSelector('.chat-agent-name')
})

afterAll(async () => {
  await browser?.close()
  cleanup()
})

test("a subagent's long name starts at its chip's left edge and ends in … inside it", async () => {
  const got = await page.evaluate(() => {
    const chip = document.querySelector('.chat-agent-chip')!.getBoundingClientRect()
    const name = document.querySelector<HTMLElement>('.chat-agent-name')!
    const box = name.getBoundingClientRect()
    return { left: box.left >= chip.left, right: box.right <= chip.right, ends: name.scrollWidth > name.clientWidth }
  })
  assert.deepEqual(got, { left: true, right: true, ends: true })
})

test("a fix's line shows its thread's whole name, on two lines in its chip, inside the chat", async () => {
  const got = await page.evaluate((width) => {
    const chip = document.querySelector<HTMLElement>('.chat-agent-note .chat-thread-chip')!
    const text = chip.querySelector<HTMLElement>('.chip-text')!
    const box = chip.getBoundingClientRect()
    return { name: text.textContent, whole: text.scrollWidth <= text.clientWidth, lines: box.height > 30, inside: box.right <= width + 8 }
  }, WIDTH)
  assert.deepEqual(got, { name: `main/${NAME}`, whole: true, lines: true, inside: true })
})
