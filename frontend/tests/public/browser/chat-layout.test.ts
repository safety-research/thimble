// The chat's list while a reply streams (src/chat/Rows.tsx Working, styles/chat.css .chat-working-row): the working
// mark comes while a reply is out and goes when it is back, and the rows above it stay where they are both times,
// since the mark takes no room in the flow. A layout that jumps under the analyst's eyes as each reply starts and ends
// is what this keeps out.
import assert from 'node:assert/strict'
import { afterAll, beforeAll, test } from 'vitest'
import type { Browser } from 'playwright'
import { bundle, cleanup, launch, open, src, type Opened } from './page.ts'

// more rows than the list shows, so it scrolls and sits at its end as a conversation does
const ROWS = Array.from({ length: 4 }, (_, k) => [
  { kind: 'user', index: 3 * k, text: 'How many refunds did the Basic plan have?' },
  { kind: 'text', index: 3 * k + 1, text: 'The Basic plan had 83 refunds over the two weeks, 43 of them in the second week, after the price change.' },
  { kind: 'user', index: 3 * k + 2, text: 'And the Pro plan?' },
]).flat()

let browser: Browser
let app: Opened

beforeAll(async () => {
  // the list as ChatPanel draws it: the rows in the flow, the list scrolled to its end
  const script = await bundle('chat-layout', [
    `import { createRoot } from 'react-dom/client'`,
    `import { flushSync } from 'react-dom'`,
    `import { Rows } from '${src('chat/Rows.tsx')}'`,
    `let root = null`,
    `const list = (rows, streaming) => <section className="chat" style={{ position: 'relative', height: 420, width: 300, display: 'flex', flexDirection: 'column' }}><div className="chat-list" id="list"><div className="chat-flow"><Rows rows={rows} ws="w" chat="main" streaming={streaming} /></div></div></section>`,
    `window.__render = (rows, streaming) => { if (!root) { const el = document.createElement('div'); document.body.appendChild(el); root = createRoot(el) } flushSync(() => root.render(list(rows, streaming))); const l = document.getElementById('list'); l.scrollTop = l.scrollHeight }`,
  ])
  browser = await launch()
  app = await open(browser, { script, styles: ['tokens', 'base', 'components', 'spinner', 'chat'], context: { viewport: { width: 600, height: 600 } } })
})

afterAll(async () => {
  await browser?.close()
  cleanup()
})

/** The last row's top in the viewport, the flow's height, and whether the working mark shows. */
const measure = () =>
  app.page.evaluate(() => {
    const flow = document.querySelector('.chat-flow')!
    const rows = flow.querySelectorAll(':scope > :not(.chat-working-row)')
    return { top: rows[rows.length - 1].getBoundingClientRect().top, height: flow.getBoundingClientRect().height, working: !!flow.querySelector('.chat-working-row') }
  })
const render = (streaming: boolean) => app.page.evaluate(([rows, s]: any) => (window as any).__render(rows, s), [ROWS, streaming] as const)

test('the working mark comes and goes as a reply streams, and the rows above it stay where they are', async () => {
  await render(false)
  const rest = await measure()
  assert.equal(rest.working, false)
  assert.ok(await app.page.evaluate(() => document.getElementById('list')!.scrollTop > 0), 'the list scrolls, at its end')
  await render(true)
  const out = await measure()
  assert.equal(out.working, true, 'the mark shows while the reply is out')
  assert.equal(out.top, rest.top, 'the last row stays put when the mark comes')
  assert.equal(out.height, rest.height, 'the flow keeps its height')
  const mark = await app.page.locator('.chat-working-row .spinner, .chat-working-row [aria-label="working"]').first().boundingBox()
  const list = await app.page.locator('#list').boundingBox()
  assert.ok(mark && list && mark.y > out.top && mark.y + mark.height <= list.y + list.height, 'the spinner shows under the last row, inside the list')
  await render(false)
  assert.equal((await measure()).top, rest.top, 'and when it goes')
  assert.deepEqual(app.errors, [])
})
