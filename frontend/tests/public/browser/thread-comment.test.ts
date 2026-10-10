// The thread a comment's Ask opened, in a real browser with thimble's own stylesheets: the real thread view
// (src/chat/ChatPanel.tsx ThreadView) of a thread anchored on a plan's step whose meta keeps the comment (backend
// comments.thread_comment, `anchor_comment`). Live check plan-cards: the anchor line named only the step, so the analyst
// could not see which comment the thread was about. Its anchor line now shows the step's chip and, under it, the
// comment: its check's square and name in the check's color, then its statement. A thread with no comment shows the chip
// alone.
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, test } from 'vitest'
import type { Browser, Page } from 'playwright'
import { bundle, cleanup, launch, ORIGIN, src } from './page.ts'

let browser: Browser
let page: Page

const STATEMENT = 'The meson cache this step adds is already in Dockerfile.agent, and the earlier runs still had agents that could not build.'
const CANVAS = {
  groups: [{ id: 'g', title: 'Your work', parent: null, kind: 'sequence', anchor: null, chat: null, role: 'analyst' }],
  cells: [{ id: 'plan1', notebook: 'g', kind: 'plan', title: 'Plan: build the offline pandas environment and pilot it', takeaway: '', created_by: 'chat:main', ts: '', payload: { steps: [], follows: null } }],
}

beforeAll(async () => {
  const script = await bundle(
    'thread-comment',
    [
      `import '${src('styles/index.css')}'`,
      `import { createRoot } from 'react-dom/client'`,
      `import { ThreadView } from '${src('chat/ChatPanel.tsx')}'`,
      `import { foldRecords } from '${src('chat/model.ts')}'`,
      `import type { ChatMeta, ChatRecord } from '${src('lib/types.ts')}'`,
      `import type { ChatState } from '${src('chat/useChat.ts')}'`,
      `const records: ChatRecord[] = [{ type: 'user', text: 'why does that matter?' }]`,
      `const comment = { id: 'k1', check: 'you-should-know', name: 'You should know', colour: 2, text: ${JSON.stringify(STATEMENT)} }`,
      `const meta = (id: string, withComment: boolean): ChatMeta => ({ id, kind: 'thread', role: 'thread', title: 'plan-build-offline', created_at: '2026-10-09T17:48:00+00:00', parent: 'main', anchor: 'card:plan1#step-4', anchor_text: 'Plan', model: null, effort: null, group: null, anchor_comment: withComment ? comment : null })`,
      `const chat = (m: ChatMeta): ChatState => ({ meta: m, records, rows: foldRecords(records), loading: false, error: null, streaming: true, running: true, send: async () => true, interrupt: async () => {}, reload: async () => {} })`,
      `const main = { ...chat(meta('main', false)), records: [], rows: [] }`,
      `function View({ id, withComment }: { id: string; withComment: boolean }) {`,
      `  const m = meta(id, withComment)`,
      `  return <ThreadView ws="w" meta={m} chat={chat(m)} main={main} skip={new Set()} branches={[]} detached={false} />`,
      `}`,
      `createRoot(document.getElementById('root')!).render(`,
      `  <div style={{ display: 'flex', gap: 24, padding: 16 }}>`,
      `    <div id="asked" className="chat-scroll" style={{ width: 420 }}><View id="t1" withComment /></div>`,
      `    <div id="plain" className="chat-scroll" style={{ width: 420 }}><View id="t2" withComment={false} /></div>`,
      `  </div>,`,
      `)`,
    ],
    { loader: { '.css': 'css', '.woff2': 'empty', '.woff': 'empty' }, conditions: ['style'] },
  )
  const css = readFileSync(script.replace(/\.js$/, '.css'), 'utf8')
  browser = await launch()
  page = await browser.newPage({ viewport: { width: 1000, height: 600 } })
  await page.route('**/*', async (route) => {
    const p = new URL(route.request().url()).pathname
    const json = (body: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
    if (p === '/bundle.css') return route.fulfill({ status: 200, contentType: 'text/css', body: css })
    if (p === '/api/ws/w/canvas') return json(CANVAS)
    if (p.startsWith('/api/')) return json({})
    return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/bundle.css"></head><body><div id="root"></div></body></html>' })
  })
  await page.goto(`${ORIGIN}/`)
  await page.addScriptTag({ path: script })
  await page.waitForSelector('#asked .chat-anchor-note')
  // a picture of both threads, for a reader who wants to look (not compared)
  const out = process.env.THIMBLE_THREAD_SHOT
  if (out) writeFileSync(path.resolve(out), await page.screenshot())
})

afterAll(async () => {
  await browser?.close()
  cleanup()
})

test("the anchor line of a thread a comment's Ask opened names the comment under the step's chip: its check in the check's color, then its statement", async () => {
  const got = await page.evaluate(() => {
    const line = document.querySelector<HTMLElement>('#asked .chat-anchor-note')!
    const chip = line.querySelector<HTMLElement>('[data-ref], .chip')!
    const cm = line.querySelector<HTMLElement>('.chat-anchor-comment')
    const name = cm?.querySelector<HTMLElement>('.chat-anchor-comment-name')
    const sq = cm?.querySelector<HTMLElement>('.wu-cm-sq')
    const r = (el: Element) => el.getBoundingClientRect()
    const sw = document.createElement('span')
    sw.style.color = 'var(--label-2)'
    document.body.appendChild(sw)
    const want = getComputedStyle(sw).color
    sw.remove()
    return {
      chipText: chip.textContent,
      id: cm?.dataset.comment,
      name: name?.textContent,
      nameColour: name ? getComputedStyle(name).color : '',
      sqColour: sq ? getComputedStyle(sq).backgroundColor : '',
      want,
      text: cm?.querySelector('.chat-anchor-comment-text')?.textContent,
      below: cm ? r(cm).top >= r(chip).bottom - 1 : false,
      inside: cm ? r(cm).right <= r(line).right + 1 : false,
    }
  })
  assert.equal(got.id, 'k1')
  assert.equal(got.name, 'You should know')
  assert.equal(got.text, STATEMENT)
  assert.ok(got.chipText?.includes('step 4'), `the step's chip stays ${got.chipText}`)
  assert.equal(got.nameColour, got.want, "the check's name in its color")
  assert.equal(got.sqColour, got.want, "the square in the check's color")
  assert.ok(got.below && got.inside, `the comment sits under the chip, inside the line ${JSON.stringify(got)}`)
})

test('a thread with no comment shows the chip alone', async () => {
  assert.equal(await page.locator('#plain .chat-anchor-note').count(), 1)
  assert.equal(await page.locator('#plain .chat-anchor-comment').count(), 0)
})
