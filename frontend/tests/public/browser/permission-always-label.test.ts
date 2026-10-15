// Main's permission card in a real browser, with thimble's own stylesheets (src/chat/PermissionCard.tsx): its "don't ask
// again" button shows the whole of its label in the chat's width, on more lines where one is too short, rather than
// "Allow, and don't ask again for…" (live check 7.f: Claude Code's words begin that way, so the cut label never said
// what it allows). In a wide chat the label stays on one line, as tall as Allow.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, test } from 'vitest'
import type { Browser, Page } from 'playwright'
import { bundle, cleanup, launch, ORIGIN, src } from './page.ts'

const ADD_CARD = "Allow, and don't ask again for Add Card"
const OUTSIDE = 'Allow, and switch to accept edits; always allow access to notes/'
let browser: Browser
let page: Page

beforeAll(async () => {
  const script = await bundle(
    'permission-always-label',
    [
      `import '${src('styles/index.css')}'`,
      `import { createRoot } from 'react-dom/client'`,
      `import { PermissionCard } from '${src('chat/PermissionCard.tsx')}'`,
      `import type { PermissionRequest } from '${src('lib/types.ts')}'`,
      `const req = (id: string, label: string): PermissionRequest => ({ id, tool: 'mcp__plugin_thimble_thimble__add_card', what: 'mcp__plugin_thimble_thimble__add_card', always: 'mcp__plugin_thimble_thimble__add_card', always_label: label, always_tip: label + ' in the folder.' })`,
      `const card = (id: string, width: number, label: string) => <div id={id} className="chat-foot-stack" style={{ width }}><PermissionCard ws="w" asks={[{ chat: 'main', request: req(id, label) }]} metas={new Map()} labels={new Map()} /></div>`,
      `createRoot(document.getElementById('root')!).render(<div style={{ display: 'flex', flexDirection: 'column', gap: 24, padding: 16 }}>{card('narrow', 310, ${JSON.stringify(ADD_CARD)})}{card('narrow2', 310, ${JSON.stringify(OUTSIDE)})}{card('wide', 640, ${JSON.stringify(ADD_CARD)})}</div>)`,
    ],
    { loader: { '.css': 'css', '.woff2': 'empty', '.woff': 'empty' }, conditions: ['style'] },
  )
  const css = readFileSync(script.replace(/\.js$/, '.css'), 'utf8')
  browser = await launch()
  page = await browser.newPage({ viewport: { width: 1100, height: 900 } })
  await page.route('**/*', async (route) => {
    const p = new URL(route.request().url()).pathname
    if (p === '/bundle.css') return route.fulfill({ status: 200, contentType: 'text/css', body: css })
    if (p.startsWith('/api/')) return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
    return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/bundle.css"></head><body><div id="root"></div></body></html>' })
  })
  await page.goto(`${ORIGIN}/`)
  await page.addScriptTag({ path: script })
  await page.waitForSelector('#wide .chat-perm-always')
})

afterAll(async () => {
  await browser?.close()
  cleanup()
})

/** The card in `where`: its box, the boxes of Allow, the "don't ask again" button and Deny, and that button's label:
 * its text and whether any of it is cut. */
const measure = (where: string) =>
  page.evaluate((w) => {
    const box = (e: Element | null) => (e ? (({ left, right, top, bottom, height }) => ({ left, right, top, bottom, height }))(e.getBoundingClientRect()) : null)
    const card = document.querySelector(`${w} .chat-perm`)!
    const always = card.querySelector('.chat-perm-always')!
    const label = always.querySelector('.btn-label') as HTMLElement
    const allow = [...card.querySelectorAll('.chat-perm-acts .btn')].find((b) => b.textContent === 'Allow') ?? null
    return {
      card: box(card), allow: box(allow), always: box(always), deny: box(card.querySelector('.chat-perm-deny')),
      text: label.textContent, cut: label.scrollWidth > label.clientWidth + 1 || label.scrollHeight > label.clientHeight + 1,
    }
  }, where)

test("the don't ask again button shows its whole label in a narrow chat, on more lines, and on one line in a wide one", async () => {
  for (const [where, label] of [['#narrow', ADD_CARD], ['#narrow2', OUTSIDE]] as const) {
    const m = await measure(where)
    assert.equal(m.text, label)
    assert.ok(!m.cut, `no part of the label is cut ${JSON.stringify(m)}`)
    assert.ok(m.always!.right <= m.deny!.left && m.deny!.right <= m.card!.right + 0.5, `Deny stays in the card after it ${JSON.stringify(m)}`)
    assert.ok(m.always!.height > m.allow!.height, `it takes more lines than Allow's one ${JSON.stringify(m)}`)
  }
  const wide = await measure('#wide')
  assert.ok(!wide.cut && wide.text === ADD_CARD, JSON.stringify(wide))
  assert.ok(Math.abs(wide.always!.height - wide.allow!.height) < 1, `one line, as tall as Allow ${JSON.stringify(wide)}`)
})
