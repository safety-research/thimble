// The chat panel's foot over its list (src/chat/ChatPanel.tsx), mounted whole against routed API answers: the glass
// composer floats over the transcript, and the newest message stays wholly above it, when the chat opens and when the
// foot grows (a draft of several lines), since a foot that grows moves only the list's padding.
import assert from 'node:assert/strict'
import { afterAll, beforeAll, test } from 'vitest'
import type { Browser } from 'playwright'
import { bundle, cleanup, launch, open, src, type Opened } from './page.ts'

const T = (m: number) => `2026-09-24T10:${String(m).padStart(2, '0')}:00Z`
const MAIN_META = { id: 'main', kind: 'main', role: 'main', title: 'main', created_at: T(0), parent: null, anchor: null, anchor_text: null, model: null, effort: null, group: null, attached: { session: 's', cwd: '/data/w', since: T(0) } }
// more turns than the list shows, so it scrolls and sits at its end
const MAIN = Array.from({ length: 8 }, (_, k) => [
  { type: 'user', ts: T(2 * k), text: `How many refunds did plan ${k + 1} have in the second week?`, by: 'browser' },
  { type: 'text', delta: `Plan ${k + 1} had ${40 + k} refunds in the second week, ${k + 3} more than in the first, after the price change.`, by: 'terminal' },
  { type: 'done', ts: T(2 * k + 1), result: 'ok' },
]).flat()

let browser: Browser
let app: Opened

beforeAll(async () => {
  const script = await bundle('chat-foot', [
    `import { createRoot } from 'react-dom/client'`,
    `import { flushSync } from 'react-dom'`,
    `import { ChatPanel } from '${src('chat/ChatPanel.tsx')}'`,
    `const el = document.createElement('div')`,
    `el.style.cssText = 'position:absolute;left:0;top:0;width:340px;height:560px;display:flex;flex-direction:column'`,
    `document.body.appendChild(el)`,
    `flushSync(() => createRoot(el).render(<ChatPanel ws="w" />))`,
  ])
  browser = await launch()
  app = await open(browser, {
    script,
    styles: ['tokens', 'base', 'components', 'spinner', 'chat'],
    context: { viewport: { width: 800, height: 600 } },
    // the start gate skipped, so main's own composer shows
    init: () => localStorage.setItem('thimble:w:start-skipped', 'true'),
    api: (_req, url) => {
      if (url.pathname === '/api/ws/w/chats') return { json: [MAIN_META] }
      if (url.pathname === '/api/ws/w/chats/main') return { json: { meta: MAIN_META, events: MAIN } }
      return undefined
    },
  })
})

afterAll(async () => {
  await browser?.close()
  cleanup()
})

/** How far (px) the newest row's bottom sits above the foot's top; negative when the foot covers it. */
const clearance = () =>
  app.page.evaluate(() => {
    const rows = [...document.querySelectorAll('.chat-flow > *')].filter((e) => e.getBoundingClientRect().height > 0)
    return Math.round(document.querySelector('.chat-foot')!.getBoundingClientRect().top - rows[rows.length - 1].getBoundingClientRect().bottom)
  })

test('the newest message stays above the composer when the chat opens and when a long draft grows it', async () => {
  const { page } = app
  await page.waitForFunction(() => document.querySelectorAll('.chat-flow .chat-user').length === 8)
  await page.waitForTimeout(300)
  assert.ok(await page.evaluate(() => document.querySelector('.chat-list')!.scrollTop > 0), 'the list scrolls, at its end')
  assert.ok((await clearance()) >= 0, 'the newest row is clear of the composer at first')
  const before = await page.evaluate(() => document.querySelector('.chat-foot')!.getBoundingClientRect().height)
  await page.locator('.chat-composer textarea').fill(['one', 'two', 'three', 'four', 'five', 'six'].map((w) => `line ${w}`).join('\n'))
  await page.waitForTimeout(300)
  const after = await page.evaluate(() => document.querySelector('.chat-foot')!.getBoundingClientRect().height)
  assert.ok(after > before + 40, `the composer grew (${before} to ${after})`)
  assert.ok((await clearance()) >= 0, 'the newest row is still clear of the grown composer')
  assert.deepEqual(app.errors, [])
})
