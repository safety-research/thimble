// A ⌘-click (Ctrl off a Mac) on a citation's words in a reply (src/marks/Mark.tsx, src/pointer/CmdPointer.tsx), in a
// real browser with thimble's own stylesheets: the highlight holds on the words, and the thread is about the citation,
// as the terminal's a on a citation is: its words, at the card place a card's value cites, else at the reply it stands
// in. The words are a control (a click opens their evidence), so the pointer found no text there and took the whole
// reply, its whole text the thread's.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, test } from 'vitest'
import type { Browser, Page } from 'playwright'
import { bundle, cleanup, launch, ORIGIN, src } from './page.ts'

let browser: Browser
let page: Page
const threads: { anchor: string; anchor_text: string }[] = []

const REPLY = 'Of the [40](#) nightly runs, [12](#) failed after the config change, and the rest passed as before.'
const output = 'runs 40\nfailed 12'
const table = { corner: 'agent', cols: ['merged', 'total'], rows: [{ label: 'agent-07', values: ['12', '40'] }], at: { r: 0, c: 0 } }
const ITEMS = [
  { n: 1, piece: 0, k: 0, words: '40', sentence: '', status: 'verified', shown: '40', evidence: { kind: 'computed', code: 'print(len(runs))', output, highlight: [[5, 7]], by: 'main' } },
  { n: 2, piece: 0, k: 1, words: '12', sentence: '', status: 'verified', shown: '12', evidence: { kind: 'card', card: 'k3f9a1', title: 'Failed runs', ref: 'card:k3f9a1#merged/agent-07', value: '12', table } },
]

beforeAll(async () => {
  const script = await bundle(
    'pointer-mark',
    [
      `import '${src('styles/index.css')}'`,
      `import { createRoot } from 'react-dom/client'`,
      `import { foldRecords } from '${src('chat/model.ts')}'`,
      `import { Rows } from '${src('chat/Rows.tsx')}'`,
      `import { CmdPointer } from '${src('pointer/CmdPointer.tsx')}'`,
      `import type { ChatRecord } from '${src('lib/types.ts')}'`,
      `const records = [`,
      `  { type: 'user', text: 'Did the failures start after the config change?' },`,
      `  { type: 'text', delta: ${JSON.stringify(REPLY)} },`,
      `  { type: 'done', turn: 'aaaaaaaa' },`,
      `  { type: 'marks', turn: 'aaaaaaaa', items: ${JSON.stringify(ITEMS)} },`,
      `] as unknown as ChatRecord[]`,
      `createRoot(document.getElementById('root')!).render(`,
      `  <>`,
      `    <section className="chat" data-panel="chat" data-chat-current="main" style={{ width: 420, padding: 16 }}>`,
      `      <Rows rows={foldRecords(records)} ws="w" chat="main" />`,
      `    </section>`,
      `    <CmdPointer ws="w" />`,
      `  </>,`,
      `)`,
    ],
    { loader: { '.css': 'css', '.woff2': 'empty', '.woff': 'empty' }, conditions: ['style'] },
  )
  const css = readFileSync(script.replace(/\.js$/, '.css'), 'utf8')
  browser = await launch()
  page = await browser.newPage({ viewport: { width: 1000, height: 700 } })
  await page.route('**/*', async (route) => {
    const req = route.request()
    const p = new URL(req.url()).pathname
    const json = (body: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
    if (p === '/bundle.css') return route.fulfill({ status: 200, contentType: 'text/css', body: css })
    if (p === '/api/ws/w/chats' && req.method() === 'POST') {
      threads.push(JSON.parse(req.postData() || '{}'))
      return json({ id: 't1', kind: 'thread', title: 'why' })
    }
    if (p.startsWith('/api/')) return json({})
    return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/bundle.css"></head><body><div id="root"></div></body></html>' })
  })
  await page.goto(`${ORIGIN}/`)
  await page.addScriptTag({ path: script })
  await page.waitForSelector('.chat-text .mark-words')
})

afterAll(async () => {
  await browser?.close()
  cleanup()
})

/** A Ctrl-click on the k-th citation's words, and a question sent from the box it opens: where the held highlight was
 * and where the words are, whether the words' evidence label opened too, and the thread the question opened. */
async function ask(k: number) {
  const words = (await page.locator('.chat-text .mark-words').nth(k).boundingBox())!
  // Ctrl held first, so the words' own label, which opens on a hover, stays shut
  await page.keyboard.down('Control')
  await page.mouse.move(words.x + words.width / 2, words.y + words.height / 2)
  await page.mouse.click(words.x + words.width / 2, words.y + words.height / 2)
  await page.keyboard.up('Control')
  await page.waitForSelector('.pointer-box', { timeout: 2000 })
  const hl = await page.evaluate(() => {
    const n = document.querySelector<HTMLElement>('.pointer-hl')!
    const m = /translate3d\(([-\d.]+)px, ([-\d.]+)px/.exec(n.style.transform)!
    return { on: n.hasAttribute('data-on'), x: +m[1], w: parseFloat(n.style.width) }
  })
  const label = await page.locator('.mark-pop').count()
  const n = threads.length
  await page.fill('.pointer-box textarea', 'how was this counted?')
  await page.press('.pointer-box textarea', 'Enter')
  await page.waitForSelector('.pointer-box', { state: 'detached', timeout: 5000 })
  assert.equal(threads.length, n + 1, 'the question opened one thread')
  return { hl, words, label, thread: { anchor: threads[n].anchor, anchor_text: threads[n].anchor_text } }
}

/** The held highlight rings the words, not the reply, and the click opened no evidence label: it is the pointer's. */
const onWords = (got: Awaited<ReturnType<typeof ask>>) =>
  assert.ok(got.hl.on && Math.abs(got.hl.x - got.words.x) < 6 && Math.abs(got.hl.w - got.words.width) < 12 && got.label === 0, `the highlight on the words ${JSON.stringify(got)}`)

test("a Ctrl-click on a citation of code's output holds the highlight on its words, and the thread is about them in the reply they stand in", async () => {
  const reply = await page.getAttribute('.chat-text', 'data-anchor')
  assert.match(reply ?? '', /^chat:main#\d+$/)
  const got = await ask(0)
  onWords(got)
  assert.deepEqual([got.thread.anchor, got.thread.anchor_text], [reply, '40'])
})

test("a Ctrl-click on a citation of a card's value asks about that place of the card, with the citation's words", async () => {
  const got = await ask(1)
  onWords(got)
  assert.deepEqual([got.thread.anchor, got.thread.anchor_text], ['card:k3f9a1#merged/agent-07', '12'])
})
