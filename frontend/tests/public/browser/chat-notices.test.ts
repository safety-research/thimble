// The foot of main's chat (chat/ChatPanel, chat/Notice, styles/chat.css) with thimble's stylesheets in headless
// Chromium, at the bug hunt's size (a 308px column, 1000px tall), against a made-up workspace this file answers: a long
// answer of main's, a view proposal and the notices of three orientation helpers that Claude's safeguards switched to
// another model (bug hunt B7). The cards above the composer take their own space: the transcript ends above them, so no
// line of it shows between the cards or under the composer, however it is scrolled; the three notices in the same
// words are one card that counts them, whose × dismisses all three. With no card above it, the transcript ends above
// the composer too (bug hunt C10). A transcript at its end stays there while rows fill in, and sending a question takes
// it to its end.
// THIMBLE_CHAT_NOTICES_SHOT=<path.png> saves a picture of the column with the cards.
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
    'chat-notices',
    [
      `import '${src('styles/index.css')}'`,
      `import { createRoot } from 'react-dom/client'`,
      `import { ChatPanel } from '${src('chat/ChatPanel.tsx')}'`,
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
const ANSWER = Array.from({ length: 14 }, (_, i) => `- Finding ${i + 1}: the corpus is four files from public wikis on the same timed task, and these lines of main's answer must never show through the cards above the composer.`).join('\n')
const EVENTS = [
  { type: 'user', ts: T, text: "what's in here and what stands out?" },
  { type: 'text', delta: ANSWER, reply: true },
  { type: 'done', ts: T },
]
const SWITCHED = "Claude's safeguards switched a reply of a helper of the orientation from Opus 5.5 to Opus 4.8."
const helper = (i: number) => ({ id: `n${i}`, key: `safeguards:orient-h${i}`, kind: 'safeguards', agent: 'Orientation helper', chat: `orient-h${i}`, text: SWITCHED, ts: T })
const PROPOSAL = { slug: 'page-histories', name: 'Page Histories', description: 'Every wiki page with its revisions in order, showing for each revision the page text, the author label, the IP prefix and the time.', task: '', claims: ['pages.jsonl'], status: 'suggested', proposed_by: 'proposer', offered: { at: T, after: 'main' } }
const MIME: Record<string, string> = { '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff' }
const INDEX = '<!doctype html><html lang="en"><head><meta charset="utf-8"><link rel="stylesheet" href="/bundle.css"></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>'

/** The column with `notices` open and, with `proposal`, the view proposal waiting; the writes the page sent. */
async function open(opts: { notices: unknown[]; proposal: boolean }): Promise<{ page: Page; writes: string[]; close: () => Promise<void> }> {
  const writes: string[] = []
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
      if (req.method() !== 'GET') writes.push(`${req.method()} ${p}`)
      if (p === `/api/ws/${WS}/events` && req.method() === 'POST') return json({ queued: true })
      if (p === `/api/ws/${WS}/events`) return route.fulfill({ status: 200, contentType: 'text/event-stream', body: ': open\n\n' })
      if (p === `/api/ws/${WS}/chats`) return json([{ ...MAIN, n_messages: 2, last_ts: T }])
      if (p === `/api/ws/${WS}/chats/main`) return json({ meta: { ...MAIN, orientation: 'done' }, events: EVENTS })
      if (p === `/api/ws/${WS}/notices`) return json(opts.notices)
      if (p.endsWith('/dismiss')) return json({ dismissed: true })
      if (p === `/api/ws/${WS}/views/proposals`) return json(opts.proposal ? [PROPOSAL] : [])
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
  await page.waitForFunction(() => document.querySelectorAll('.chat-flow li').length >= 14)
  return { page, writes, close: () => ctx.close() }
}

/** Scroll the transcript to its top, so its answer runs down past the foot, and wait for the layout. */
const toTop = (page: Page) =>
  page.evaluate(async () => {
    document.querySelector('.chat-list')!.scrollTop = 0
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
  })

/** The points of the foot where a line of the transcript is drawn under it: in each gap between two cards of the foot,
 * and on the composer; [] when the transcript shows nowhere under the foot. */
const throughFoot = (page: Page) =>
  page.evaluate(() => {
    const foot = document.querySelector('.chat-foot')!
    const parts = [...foot.querySelectorAll('.chat-offer, .chat-notice, .composer')].map((el) => el.getBoundingClientRect())
    const x = parts[parts.length - 1].left + parts[parts.length - 1].width / 2
    const points: [string, number][] = []
    for (let i = 1; i < parts.length; i++) if (parts[i].top - parts[i - 1].bottom >= 2) points.push([`gap ${i}`, (parts[i - 1].bottom + parts[i].top) / 2])
    const composer = parts[parts.length - 1]
    for (const f of [0.25, 0.5, 0.75]) points.push([`composer ${f}`, composer.top + composer.height * f])
    return points.filter(([, y]) => document.elementsFromPoint(x, y).some((el) => el.closest('.chat-flow'))).map(([name]) => name)
  })

test('the cards above the composer take their own space, and notices in the same words are one card with a count', async () => {
  const { page, writes, close } = await open({ notices: [helper(1), helper(2), helper(3)], proposal: true })
  try {
    await page.waitForSelector('.chat-foot .chat-offer')
    await page.waitForSelector('.chat-foot .chat-notice')
    await toTop(page)
    const shot = process.env.THIMBLE_CHAT_NOTICES_SHOT
    if (shot) writeFileSync(path.resolve(shot), await page.screenshot())
    assert.deepEqual(await throughFoot(page), [], 'no line of the transcript under the cards or the composer')
    // the end of the answer still reads above the cards
    await page.evaluate(() => {
      const list = document.querySelector('.chat-list')!
      list.scrollTop = list.scrollHeight
    })
    const ends = await page.evaluate(() => {
      const last = [...document.querySelectorAll('.chat-flow li')].at(-1)!.getBoundingClientRect()
      const card = document.querySelector('.chat-foot .chat-offer')!.getBoundingClientRect()
      const list = document.querySelector('.chat-list')!.getBoundingClientRect()
      return { lastBottom: last.bottom, cardTop: card.top, listTop: list.top }
    })
    assert.ok(ends.lastBottom <= ends.cardTop, `the answer's last line (${ends.lastBottom}) ends above the cards (${ends.cardTop})`)
    assert.ok(ends.cardTop - ends.listTop > 300, `the transcript keeps room to read (${ends.cardTop - ends.listTop}px)`)
    // the three notices in the same words: one card that counts them
    const cards = await page.evaluate(() =>
      [...document.querySelectorAll('.chat-foot .chat-notice')].map((n) => ({ count: n.querySelector('.chat-notice-count')?.textContent ?? '', text: n.querySelector('.chat-notice-text')?.textContent ?? '' })),
    )
    assert.equal(cards.length, 1, 'one card for the three notices')
    assert.equal(cards[0].count, '×3')
    assert.ok(cards[0].text.includes(SWITCHED), cards[0].text)
    await page.click('.chat-foot .chat-notice-x')
    await page.waitForFunction(() => !document.querySelector('.chat-foot .chat-notice'))
    assert.deepEqual(writes.filter((w) => w.endsWith('/dismiss')).sort(), [1, 2, 3].map((i) => `POST /api/ws/${WS}/notices/n${i}/dismiss`))
  } finally {
    await close()
  }
}, 60_000)

test('with no card above it, no line of the transcript shows under the composer', async () => {
  const { page, close } = await open({ notices: [], proposal: false })
  try {
    await toTop(page)
    assert.deepEqual(await throughFoot(page), [], 'the transcript ends above the composer')
  } finally {
    await close()
  }
}, 60_000)

/** How far the transcript is from its end, in px, after a few frames. */
const fromEnd = (page: Page) =>
  page.evaluate(async () => {
    const frames = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(r))))
    await frames()
    await frames()
    const list = document.querySelector('.chat-list')!
    return list.scrollHeight - list.scrollTop - list.clientHeight
  })

test('a transcript at its end stays there while rows fill in, and sending a question takes it to its end', async () => {
  const { page, writes, close } = await open({ notices: [], proposal: false })
  try {
    assert.ok((await fromEnd(page)) < 2, 'the transcript opens at its end')
    // the list follows a row that grew with a scroll of its own, and in the same frame a row under it fills in (a card
    // reading its agent's log), as when the browser is busy in Files
    await page.evaluate(() => {
      const list = document.querySelector('.chat-list')!
      const flow = document.querySelector('.chat-flow')!
      const row = (h: number) => Object.assign(flow.appendChild(document.createElement('div')), { className: 'test-row' }).style.setProperty('height', `${h}px`)
      row(40)
      list.scrollTop = list.scrollHeight
      row(400)
    })
    assert.ok((await fromEnd(page)) < 2, 'the transcript is still at its end')
    // the analyst scrolls up to read; the list stays where they put it
    await page.evaluate(() => {
      document.querySelector('.chat-list')!.scrollTop = 0
    })
    assert.ok((await fromEnd(page)) > 400, 'the transcript stays where the analyst scrolled it')
    await page.fill('.chat-foot .composer-text', 'which run failed first?')
    await page.press('.chat-foot .composer-text', 'Enter')
    await page.waitForFunction(() => !(document.querySelector('.chat-foot .composer-text') as HTMLTextAreaElement).value)
    assert.ok(writes.includes(`POST /api/ws/${WS}/events`), writes.join(', '))
    assert.ok((await fromEnd(page)) < 2, 'sending a question takes the transcript to its end, where the question shows')
  } finally {
    await close()
  }
}, 60_000)
