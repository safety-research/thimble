// Main's chat follows its end (chat/ChatPanel) in headless Chromium with thimble's stylesheets, at the bug hunt's size (a
// 308px column, 1000px tall), against a made-up workspace this file answers: main's long chat, a side thread, and two
// notices whose fixes the analyst presses. Only the analyst's own scroll up stops the follow, never a scroll the layout
// makes (bug hunt E12, after C10): a side thread opens at its end, though its list empties while it loads; coming back
// to main, a notice's fix that changes the foot, and a row above the view that shrinks as rows come below it (which
// the browser's scroll anchoring answers by moving the list up) all leave main at its end as it answers. A wheel up
// stops it; rows that come then show "New messages", which takes the transcript to its end, where it follows again.
// THIMBLE_CHAT_FOLLOW_SHOT=<path.png> saves a picture of the column with New messages.
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, test } from 'vitest'
import type { Browser, Page, Route } from 'playwright'
import { bundle, cleanup, launch, ORIGIN, src } from './page.ts'

const WS = 'wiki'
const T = '2026-10-17T01:16:00.000+00:00'
let browser: Browser
let out = ''

beforeAll(async () => {
  const script = await bundle(
    'chat-follow',
    [
      `import '${src('styles/index.css')}'`,
      `import { createRoot } from 'react-dom/client'`,
      `import { ChatPanel } from '${src('chat/ChatPanel.tsx')}'`,
      `import { dispatch } from '${src('lib/events.ts')}'`,
      `;(window as unknown as { feed: typeof dispatch }).feed = dispatch`,
      `createRoot(document.getElementById('root')!).render(<div className="shell"><div className="shell-body" style={{ height: 1000 }}><aside className="shell-left" style={{ width: 308 }}><ChatPanel ws="${WS}" /></aside></div></div>)`,
    ],
    {
      loader: { '.css': 'css', '.woff2': 'file', '.woff': 'file' },
      conditions: ['style'],
      assetNames: '[name]-[hash]',
      publicPath: '/',
      define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env.BASE_URL': '"/"' },
    },
  )
  out = path.dirname(script)
  browser = await launch()
})

afterAll(async () => {
  await browser?.close()
  cleanup()
})

const MAIN = { id: 'main', kind: 'main', role: 'main', title: 'main', created_at: T, parent: null, anchor: null, anchor_text: null, model: null, effort: null, group: null, attached: { session: 's1', cwd: `/home/analyst/${WS}`, since: T }, ended: null, alert: null, running: false }
const THREAD = { id: 't1', kind: 'thread', role: 'thread', title: 'why-the-spike', created_at: T, parent: 'main', anchor: null, anchor_text: null, model: null, effort: null, group: null, ended: null, alert: null, running: false, question: 'why the spike?', n_messages: 2, last_ts: T }
const para = (n: number) => Array.from({ length: 6 }, (_, i) => `- Point ${i + 1} of answer ${n}: the barges move cargo along the canal in three hops, and the ledgers say when.`).join('\n')
const turn = (n: number) => [
  { type: 'user', ts: T, text: `question ${n} about the barges?` },
  { type: 'tool_use', id: `u${n}`, name: 'Bash', input: { command: `wc -l ledger-${n}.jsonl` } },
  { type: 'tool_result', tool_use_id: `u${n}`, content: `${n * 10} ledger-${n}.jsonl` },
  { type: 'text', delta: para(n), reply: true },
  { type: 'done', ts: T },
]
const VIEW_NOTICE = { id: 'nv', key: 'view:barge-routes', kind: 'view', agent: 'View build: Barge Routes', chat: 'dev-1', text: "Claude's safeguards stopped its request.", action: { do: 'view-retry', slug: 'barge-routes', label: 'Retry' }, ts: T }
const LABEL_NOTICE = { id: 'nl', key: 'label:c1', kind: 'label', agent: 'Label: late cargo', chat: 'main', text: "The label couldn't label 21 of 134 records.", action: [{ do: 'label-again', slug: 'c1', label: 'Run again on these 21' }, { do: 'label-open', slug: 'c1', label: 'See the label' }], ts: T }
const MIME: Record<string, string> = { '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff' }
const INDEX = '<!doctype html><html lang="en"><head><meta charset="utf-8"><link rel="stylesheet" href="/bundle.css"></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>'

async function open(): Promise<{ page: Page; state: { events: unknown[]; notices: unknown[] }; close: () => Promise<void> }> {
  const state = { events: Array.from({ length: 12 }, (_, i) => turn(i + 1)).flat() as unknown[], notices: [VIEW_NOTICE, LABEL_NOTICE] as unknown[] }
  const ctx = await browser.newContext({ viewport: { width: 332, height: 1000 }, deviceScaleFactor: 1 })
  const page = await ctx.newPage()
  page.on('pageerror', (e) => console.warn('page error:', e.message))
  await page.route('**/*', (route: Route) => {
    const req = route.request()
    const url = new URL(req.url())
    if (url.origin !== ORIGIN) return route.abort()
    const p = url.pathname
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
    if (p.startsWith('/api/')) {
      if (p === `/api/ws/${WS}/events` && req.method() === 'POST') return json({ queued: true })
      if (p === `/api/ws/${WS}/events`) return route.fulfill({ status: 200, contentType: 'text/event-stream', body: ': open\n\n' })
      if (p === `/api/ws/${WS}/chats`) return json([{ ...MAIN, n_messages: 24, last_ts: T }, THREAD])
      if (p === `/api/ws/${WS}/chats/main`) return json({ meta: MAIN, events: state.events })
      if (p === `/api/ws/${WS}/chats/t1`) return json({ meta: THREAD, events: [{ type: 'user', ts: T, text: 'why the spike?' }, { type: 'text', delta: 'Because of the barges.', reply: true }, { type: 'done', ts: T }] })
      if (p === `/api/ws/${WS}/notices`) return json(state.notices)
      if (p.endsWith('/dismiss')) {
        const id = p.split('/').at(-2)
        state.notices = state.notices.filter((n) => (n as { id: string }).id !== id)
        return json({ dismissed: true })
      }
      if (p.endsWith('/retry')) return json({ slug: 'barge-routes', status: 'building' })
      if (p.endsWith('/apply/again')) return json({ id: 'c1', status: 'running' })
      if (p === `/api/ws/${WS}/views/proposals`) return json([])
      if (p === `/api/ws/${WS}/settings`) return json({ propose_views: true, models: {}, permission_modes: {}, disabled_modes: [], config_error: '' })
      return json({ detail: 'not found' }, 404)
    }
    if (p === '/') return route.fulfill({ status: 200, contentType: 'text/html', body: INDEX })
    const file = path.join(out, p)
    if (existsSync(file)) return route.fulfill({ status: 200, contentType: MIME[path.extname(file)] ?? 'application/octet-stream', body: readFileSync(file) })
    return route.fulfill({ status: 404, body: '' })
  })
  await page.goto(`${ORIGIN}/`)
  await page.waitForSelector('.chat-foot .composer')
  await page.waitForFunction(() => document.querySelectorAll('.chat-flow .chat-user').length >= 12)
  return { page, state, close: () => ctx.close() }
}

const fromEnd = (page: Page) =>
  page.evaluate(async () => {
    const frames = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(r))))
    await frames()
    await frames()
    const list = document.querySelector('.chat-list')!
    return list.scrollHeight - list.scrollTop - list.clientHeight
  })

/** Main answers turn `n`: its records grow and the stream says main's chat changed. */
async function answer(page: Page, state: { events: unknown[] }, n: number) {
  state.events = [...state.events, ...turn(n)]
  await page.evaluate(() => (window as unknown as { feed: (e: unknown) => void }).feed({ type: 'chat', chat: 'main' }))
  await page.waitForFunction((k) => document.querySelectorAll('.chat-flow .chat-user').length >= k, n)
}

test("main's chat stays at its end through a thread switch, a notice's fix and a row that resizes above as rows come; a wheel up stops it and shows New messages", async () => {
  const { page, state, close } = await open()
  try {
    assert.ok((await fromEnd(page)) < 2, 'main opens at its end')
    // a side thread opens at its end, though its list empties while it loads
    await page.click('.chat-tree .tt-caret')
    await page.click('.chat-tree [data-thread="t1"]')
    await page.waitForSelector('[data-chat-current="t1"] .chat-flow .chat-user')
    assert.ok((await fromEnd(page)) < 2, 'the side thread opens at its end')
    await page.click('.chat-tree .tt-caret').catch(() => undefined)
    await page.click('.chat-tree [data-thread="main"]')
    await page.waitForSelector('[data-chat-current="main"]')
    await answer(page, state, 13)
    assert.ok((await fromEnd(page)) < 2, 'back in main, its answer shows')
    // the notices' fixes: each notice goes and the foot changes
    await page.click('.chat-foot button:has-text("Run again on these 21")')
    await answer(page, state, 14)
    assert.ok((await fromEnd(page)) < 2, "after a label notice's fix, main's answer shows")
    await page.click('.chat-foot button:has-text("Retry")')
    await page.waitForFunction(() => !document.querySelector('.chat-foot .chat-notice'))
    await answer(page, state, 15)
    assert.ok((await fromEnd(page)) < 2, "after a view notice's fix, main's answer shows")
    // a row above the view shrinks as a row comes below it, in one layout (a card above that collapses as main answers)
    await page.evaluate(() => ((document.querySelectorAll('.chat-flow .chat-user')[3] as HTMLElement).style.height = '200px'))
    await fromEnd(page)
    await page.evaluate(() => {
      ;(document.querySelectorAll('.chat-flow .chat-user')[3] as HTMLElement).style.height = '20px'
      Object.assign(document.querySelector('.chat-flow')!.appendChild(document.createElement('div')), { className: 'test-row' }).style.height = '400px'
    })
    await answer(page, state, 16)
    assert.ok((await fromEnd(page)) < 2, 'the list moved by the layout still follows its end')
    assert.equal(await page.$('.chat-new'), null, 'no New messages at the end')
    // the analyst's wheel up stops it: rows that come leave the list where it is, and New messages shows
    const box = (await page.$('.chat-list'))!.boundingBox()
    const at = (await box)!
    await page.mouse.move(at.x + at.width / 2, at.y + at.height / 2)
    await page.mouse.wheel(0, -900)
    const away = await fromEnd(page)
    assert.ok(away > 400, `the wheel moved the list up (${away}px from its end)`)
    await answer(page, state, 17)
    assert.ok((await fromEnd(page)) > away, 'the list stays where the analyst put it')
    await page.waitForSelector('.chat-new button:has-text("New messages")')
    const shot = process.env.THIMBLE_CHAT_FOLLOW_SHOT
    if (shot) writeFileSync(path.resolve(shot), await page.screenshot())
    // New messages takes it to its end, where it follows again
    await page.click('.chat-new button')
    assert.ok((await fromEnd(page)) < 2, 'New messages takes the list to its end')
    assert.equal(await page.$('.chat-new'), null, 'New messages goes')
    await answer(page, state, 18)
    assert.ok((await fromEnd(page)) < 2, 'it follows again')
  } finally {
    await close()
  }
}, 60_000)
